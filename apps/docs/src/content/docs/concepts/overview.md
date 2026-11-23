---
title: Overview
description: Organizations, projects, environments, servers, applications, releases and deployments, and how they fit together.
---

## Where things live

- **Organization**: the top level. It owns its members, its projects and its servers. You belong to one or more organizations, each with a role.
- **Project**: a group of environments for one product or one client.
- **Environment**: an isolated target inside a project, such as `production` or `staging`. It has its own applications, secrets and domains. A protected environment accepts deployments from administrators only.
- **Server**: a machine you own that runs the Shipkeep agent, enrolled in one organization. The control plane places applications on the servers that have room for them.
- **Application**: a deployable unit inside an environment, described by its `shipkeep.yml`. Today an application runs a container image; building from a Git repository and Compose applications are planned.

## From a configuration to running containers

- **Release**: an immutable pair of an image digest and the configuration resolved for it. Every deployment of a new configuration or a new image makes a release, so you can return to any earlier one.
- **Deployment**: the process that turns a release into running replicas. You can follow each of its steps, from `queued` to `succeeded`:
  1. The image tag is resolved to a digest, so that every replica runs the same image.
  2. Replicas are placed on servers that have room for the memory and CPU they ask for.
  3. Each server pulls the image, creates and starts the containers, and checks their health.
  4. When every replica is healthy, the routes switch to them, then the previous replicas are drained and stopped.
- **Failure**: a deployment that fails before the switch leaves the previous release serving, untouched. A failure during the switch puts the previous routes back.
- **Rollback**: deploys an earlier release that succeeded, the same way.
- **Stop**: removes the application's routes and replicas and frees their room on the servers. The releases and the history stay, and deploying starts it again.
- **Maintenance**: visitors get a maintenance page served by Caddy, while the replicas keep running. Deploying waits until maintenance is left.

## Routing and HTTPS

Each server runs Caddy, which the agent drives through its admin API. When an application has domains, its route on each server sends their traffic to that server's healthy replicas. Caddy obtains the certificates, once each domain's DNS record points to the server.

The routes live on the servers. If the control plane goes down, applications keep serving from what each agent stored.

## Secrets

Secrets are set per environment, by name, and are write-only: nobody reads a value back, not even an owner. They are encrypted at rest, and their values reach the agent only inside the encrypted action that starts a container. `shipkeep.yml` lists the names an application uses, never the values.

## Roles and safety

- Organization roles are `owner`, `admin` and `member`. Members get `admin`, `developer` or `viewer` on a project or an environment.
- Every change is recorded in the audit log, with who made it.
- Anything destructive, such as deleting an application or removing a server, asks you to confirm it by typing its name.
- API tokens carry scopes, which can only narrow what their owner may do.
