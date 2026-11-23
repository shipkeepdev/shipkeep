---
title: Move an application to Shipkeep
description: Move a stateless container application from Docker Compose, Coolify or another platform to Shipkeep, by hand, then switch its domain.
---

Shipkeep runs container images today. An application moves when it runs from an image and keeps its data elsewhere, in a database or an object store it reaches over the network. An import from Coolify that does this for you is planned.

:::caution[What cannot move yet]

- **Data on a volume.** Shipkeep does not mount volumes yet and refuses `volumes` in `shipkeep.yml`. Keep a database or any other stateful service where it runs today, and give the application its address in a secret.
- **Builds.** Shipkeep does not build images yet. If your platform builds from a Git repository, build the image in your CI and push it to a registry.
- **Compose files.** Shipkeep runs one container per application. Move each service you need as an application of its own.
  :::

## 1. Get an image

- **The application already runs from an image**, such as a Compose `image:` line: use that reference, and prefer a fixed tag to `latest`. Shipkeep resolves the tag to a digest at each deployment, so all replicas run the same image.
- **Your platform builds it**, such as Coolify with a Dockerfile or Nixpacks: build it in your CI, push it to a registry, and use that reference.

Public images need no setting. For a private registry, add its credentials under **Organization**, **Registries**.

## 2. Write its `shipkeep.yml`

How the settings of a Compose service map:

| Docker Compose                          | `shipkeep.yml`                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `image: ghcr.io/acme/web:1.4.2`         | `build: { type: image, image: ghcr.io/acme/web:1.4.2 }`                                                        |
| `ports: ["8080:3000"]`                  | `run.port: 3000`: the port inside the container. Nothing is published on the server; Caddy routes the domains. |
| `command: ["node", "server.js"]`        | `run.command: [node, server.js]`, always a list: no shell is involved.                                         |
| `environment:` that are not secret      | `env:`                                                                                                         |
| `environment:` that are passwords, keys | `secrets:`, with the names only. Set the values on the environment.                                            |
| `healthcheck:` with `curl` on a path    | `run.healthcheck.path`, probed over HTTP on `run.port`.                                                        |
| `deploy.replicas`                       | `scale.replicas`                                                                                               |
| `deploy.resources.limits`               | `resources.cpu` and `resources.memory`, which placement also reserves on the server.                           |
| Traefik or Caddy labels for a domain    | `domains:`                                                                                                     |
| `volumes:`                              | Not yet: keep the data outside the container.                                                                  |
| `depends_on:` a database                | Keep the database where it is, and pass its address as a secret, such as `DATABASE_URL`.                       |

For example, a web service that reads its database from `DATABASE_URL`:

```yaml
version: 1
name: web
build:
  type: image
  image: ghcr.io/acme/web:1.4.2
run:
  port: 3000
  healthcheck:
    path: /health
env:
  NODE_ENV: production
secrets:
  - DATABASE_URL
resources:
  cpu: '0.5'
  memory: 512Mi
domains:
  - new.example.com
```

The [reference](/reference/shipkeep-yml/) lists every field, and what Shipkeep does with it today.

## 3. Deploy it next to the old one

1. Set the secrets on the environment, under **Variables and secrets**.
2. Point a new name, such as `new.example.com`, at a Shipkeep server, and list only that name under `domains`.
3. Deploy, as in [First deployment](/start/first-deployment/). Caddy obtains a certificate for the new name.
4. Check the application on `https://new.example.com`, while the old one still serves your domain.

The database is shared during this time, so both copies must agree on its schema. A `release` command, such as a migration, runs before each new release takes the traffic.

## 4. Switch the domain

1. A day before, lower the TTL of your domain's DNS record, for example to 300 seconds.
2. Add your domain to `domains`, save, and deploy.
3. Point your domain's record at the Shipkeep server. Caddy obtains its certificate as soon as the domain reaches it.
4. Once the record has propagated and traffic reaches Shipkeep, stop the old application, and raise the TTL again.

To go back, point the record at the old platform again: nothing on it has changed.
