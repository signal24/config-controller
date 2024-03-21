# config-controller

Simple Kubernetes controller to create key/value Secrets from encrypted .env files stored in ConfigMaps.

Based on the [@signal24/config](https://github.com/signal24/node-config) package.

## Installation

```
helm repo add signal24.github.io/charts
helm repo update
helm install --namespace kube-system config-controller signal24/config-controller
```

## Usage

### Source ConfigMap

Load an [encrypted .env file](https://github.com/signal24/node-config?tab=readme-ov-file#setup) into a ConfigMap.  Set the following labels:

- `config.s24.dev/decryption-secret: dotenv-crypto-secrets`
- `config.s24.dev/decryption-secret-key: CONFIG_SECRET_KEY` (optional, defaults to `CONFIG_DECRYPTION_KEY`)
- `config.s24.dev/source-key: env_content` (optional, defaults to `.env`)
- `config.s24.dev/target-secret: myapp-config`

For example:
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: myapp-dotenv
  namespace: myapp
  labels:
    config.s24.dev/decryption-secret: myapp-dotenv-crypto
    config.s24.dev/target-secret: myapp-config
data:
  .env: |
    TWILIO_ACCOUNT_SID=AC123456
    TWILIO_AUTH_TOKEN_SECRET=$$[AQJLlkLEOjifkSWRHozwOK78xJfym11/utjD7NZwbYXOUTMMXHg+Fa34wt/ytB4LRB2kiD6qXSYTQQLPYRmxN+1/VcvWCATWPUXJEN+pl8MiaO5boOGMYqcTT9JVUQ+dyEZelJkR+fuhzAeoANKyicPFwYa7DiLRwUlLxca/7lnEiROzrh1YNtvWPM0+J3yjjh/zbwbRUWCVFRcP/jmToE5EGifGYhpSjzY004LDWNfF8fKiotZiISMXq8vbDBBpmYugmkHy6Q+DXMIoVsRhg/jY1LSO8ycNaE8eAjgS05tjnXo35Nx9Wr+QSKAU99+M0yK3zfq7nSnIfVQ7IRQXNV4N2Dte02ZX+AkPwNg/mPeWXD+Acnxzu2KDi4R9nmb1Qnk6VJ+BlejbtO+KhGexkDF9a2pvZyN+LDQM3c1OfL/WpqdIZkSsg7fhDWHYnTGUlr1tOxPndptc6im65Kq05/0ynB/e04HMopDz1EmkSXVV]
```

You could, for example, do this as part of a Helm deployment:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: myapp-dotenv
  labels:
    config.s24.dev/decryption-secret: {{ .Values.dotenv.decryptionSecret }}
    config.s24.dev/target-secret: {{ .Values.dotenv.targetSecret }}
data:
  .env: |
    {{ .Values.dotenv.content | nindent 4 }}
```

### Decryption Key

Create a secret with your decryption key:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: myapp-dotenv-crypto
  namespace: myapp
type: Opaque
data:
  CONFIG_DECRYPTION_KEY: >-
    TFlJRXZn...long decryption key...xZRhXMcQ
```

### 🪄 Auto-Generated Config Secret

The controller will automatically generate a secret with the keys & decrypted values from the raw .env content:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: myapp-config
  namespace: myapp
  labels:
    config.s24.dev/source-configmap: myapp-dotenv
    config.s24.dev/source-configmap-version: '123456'
type: Opaque
stringData:
  TWILIO_ACCOUNT_SID: AC123456
  TWILIO_AUTH_TOKEN_SECRET: SecretToken
```

You can now mount this secret into your workload:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
spec:
  selector:
    matchLabels:
      app: myapp
  template:
    metadata:
      labels:
        app: myapp
    spec:
      containers:
        - name: myapp
          image: myapp:latest

          # all variables
          envFrom:
            - secretRef:
                name: myapp-config

          # select variables
          env:
            - name: TWILIO_AUTH_TOKEN_SECRET
              valueFrom:
                secretKeyRef:
                  name: myapp-config
                  key: TWILIO_AUTH_TOKEN_SECRET
```

The config secret will be automatically updated any time the source ConfigMap is updated, and will be automatically deleted when the ConfigMap is deleted.
