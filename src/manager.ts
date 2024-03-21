import * as k8s from '@kubernetes/client-node';
import { parseEnvContent } from '@signal24/config';

import { K8sClient } from './k8s';
import { createLogger } from './logger';

export class Manager {
    private logger = createLogger('K8sClient');
    private kubeWatch: k8s.Watch;
    private isReady = false;
    private isPendingSync = true;
    private cache: { [key: string]: { secret?: k8s.V1Secret; configMap?: k8s.V1ConfigMap } } = {};

    constructor(private k8sClient: K8sClient) {
        this.kubeWatch = new k8s.Watch(this.k8sClient.kubeConfig);
        this.logger.info('Manager created');
    }

    async start() {
        await this.watchConfigMaps();
        await this.watchSecrets();

        await new Promise(resolve => setTimeout(resolve, 5_000));
        this.isReady = true;
        this.syncSecrets();

        setInterval(() => this.syncSecrets(), 30_000);
    }

    async watchConfigMaps() {
        this.logger.info('Starting ConfigMap watch');
        await this.kubeWatch.watch(
            '/api/v1/configmaps',
            {
                labelSelector: 'config.s24.dev/target-secret'
            },
            (type, configMap: k8s.V1ConfigMap) => {
                this.logger.info(`ConfigMap ${configMap.metadata?.name} ${type}`);
                const secretName = `${configMap.metadata?.namespace}/${configMap.metadata?.labels?.['config.s24.dev/target-secret']}`;

                if (type === 'DELETED') {
                    this.cache[secretName] = { ...this.cache[secretName], configMap: undefined };
                } else {
                    this.cache[secretName] = { ...this.cache[secretName], configMap };
                }

                this.syncSecrets();
            },
            err => {
                this.logger.error({ err }, 'Failed to watch ConfigMaps');
                setTimeout(() => this.watchConfigMaps(), 1000);
            }
        );
    }

    async watchSecrets() {
        this.logger.info('Starting Secret watch');
        await this.kubeWatch.watch(
            '/api/v1/secrets',
            {
                labelSelector: 'config.s24.dev/source-configmap'
            },
            (type, secret) => {
                this.logger.info(`Secret ${secret.metadata.name} ${type}`);
                const secretName = `${secret.metadata.namespace}/${secret.metadata.name}`;

                if (type === 'DELETED') {
                    this.cache[secretName] = { ...this.cache[secretName], secret: undefined };
                } else {
                    this.cache[secretName] = { ...this.cache[secretName], secret };
                }

                this.syncSecrets();
            },
            err => {
                this.logger.error({ err }, 'Failed to watch Secrets');
                setTimeout(() => this.watchSecrets(), 1000);
            }
        );
    }

    syncSecrets() {
        if (!this.isReady) {
            this.isPendingSync = true;
            return;
        }

        this.isReady = false;
        this.isPendingSync = false;

        this._syncSecrets()
            .then(() => {
                this.logger.info('Secrets synced');
            })
            .catch(err => {
                this.logger.error({ err }, 'Failed to sync secrets');
            })
            .finally(() => {
                this.isReady = true;
                this.isPendingSync && setTimeout(() => this.syncSecrets(), 0);
            });
    }

    private async _syncSecrets() {
        for (const secretName in this.cache) {
            const { secret, configMap } = this.cache[secretName];

            if (!secret && !configMap) {
                delete this.cache[secretName];
                continue;
            }

            if (!configMap) {
                this.logger.info(`ConfigMap for ${secretName} not found. Deleting secret.`);
                try {
                    await this.k8sClient.coreV1Api.deleteNamespacedSecret(secret!.metadata!.name!, secret!.metadata!.namespace!);
                    delete this.cache[secretName];
                } catch (err) {
                    this.logger.error({ err }, `Failed to delete secret ${secretName}`);
                }
            }

            if (!secret) {
                this.logger.info(`Secret for ${secretName} does not exist. Creating secret.`);
                try {
                    this.cache[secretName].secret = await this.createSecretForConfigMap(configMap!);
                } catch (err) {
                    this.logger.error({ err }, `Failed to create secret ${secretName}`);
                }
            } else if (secret.metadata!.labels!['config.s24.dev/source-configmap-version'] !== configMap!.metadata!.resourceVersion) {
                this.logger.info(`ConfigMap for ${secretName} updated. Updating secret.`);
                try {
                    this.cache[secretName].secret = await this.createSecretForConfigMap(configMap!, secret);
                } catch (err) {
                    this.logger.error({ err }, `Failed to update secret ${secretName}`);
                }
            }
        }
    }

    private async createSecretForConfigMap(configMap: k8s.V1ConfigMap, existingSecret?: k8s.V1ConfigMap): Promise<k8s.V1Secret> {
        const sourceKey = configMap.metadata?.labels?.['config.s24.dev/source-key'] ?? '.env';
        const sourceData = configMap.data?.[sourceKey];
        if (sourceData === undefined) {
            throw new Error(`Key ${sourceKey} not found in ConfigMap ${configMap.metadata?.name}`);
        }

        const keySecretName = configMap.metadata?.labels?.['config.s24.dev/decryption-secret'];
        const keySecretKey = configMap.metadata?.labels?.['config.s24.dev/decryption-secret-key'] ?? 'CONFIG_DECRYPTION_KEY';
        const decryptionSecret = keySecretName
            ? await this.getDecryptionSecret(configMap.metadata!.namespace!, keySecretName, keySecretKey)
            : undefined;

        const targetSecret = configMap.metadata!.labels!['config.s24.dev/target-secret'];

        const secretData = await this.extractConfigFromEncryptedEnv(sourceData, decryptionSecret);
        const secret = await this.createSecretWithConfigMapData(configMap, targetSecret, secretData, existingSecret);

        return secret;
    }

    private async getDecryptionSecret(sourceNs: string, keySecretName: string, keySecretKey: string): Promise<string> {
        // TODO: There's a security risk involved here. Figure out how to make this more secure. Maybe require an annotation on the source secret?
        // const [secretNs, secretName] = keySecretName.includes('/') ? keySecretName.split('/') : [sourceNs, keySecretName];
        const [secretNs, secretName] = [sourceNs, keySecretName];
        const { body: secret } = await this.k8sClient.coreV1Api.readNamespacedSecret(secretName, secretNs);
        if (secret.data?.[keySecretKey] === undefined) {
            throw new Error(`Key ${keySecretKey} not found in secret ${keySecretName}`);
        }
        return Buffer.from(secret.data[keySecretKey], 'base64').toString('utf-8');
    }

    private async extractConfigFromEncryptedEnv(data: string, decryptionSecret?: string): Promise<{ [key: string]: string }> {
        return parseEnvContent(data, decryptionSecret);
    }

    private async createSecretWithConfigMapData(
        configMap: k8s.V1ConfigMap,
        name: string,
        data: { [key: string]: string },
        existingSecret?: k8s.V1Secret
    ): Promise<k8s.V1Secret> {
        const secret: k8s.V1Secret = {
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: {
                name,
                namespace: configMap.metadata!.namespace!,
                labels: {
                    'config.s24.dev/source-configmap': configMap.metadata!.name!,
                    'config.s24.dev/source-configmap-version': configMap.metadata!.resourceVersion!
                }
            },
            type: 'Opaque',
            data: {}
        };

        for (const key in data) {
            secret.data![key] = Buffer.from(data[key]).toString('base64');
        }

        const { body } = existingSecret
            ? await this.k8sClient.coreV1Api.replaceNamespacedSecret(secret.metadata!.name!, secret.metadata!.namespace!, secret)
            : await this.k8sClient.coreV1Api.createNamespacedSecret(secret.metadata!.namespace!, secret);
        return body;
    }
}
