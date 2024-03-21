import * as k8s from '@kubernetes/client-node';

export class K8sClient {
    public readonly kubeConfig: k8s.KubeConfig;
    public readonly coreV1Api: k8s.CoreV1Api;

    constructor() {
        this.kubeConfig = new k8s.KubeConfig();
        if (process.env.KUBERNETES_SERVICE_HOST) {
            this.kubeConfig.loadFromCluster();
        } else {
            this.kubeConfig.loadFromDefault();
        }

        this.coreV1Api = this.kubeConfig.makeApiClient(k8s.CoreV1Api);
    }
}
