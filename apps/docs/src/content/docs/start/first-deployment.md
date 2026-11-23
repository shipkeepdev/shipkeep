---
title: First deployment
description: Create a project and an environment, deploy a container image, give it a domain, and roll it back, from the web UI or the CLI.
---

This page deploys a public container image, `nginx:1.27`, and gives it a domain with HTTPS. Shipkeep deploys container images today; building from a Git repository is planned.

## Before you start

- The control plane is [installed](/start/install/), and you can sign in.
- **Servers** lists at least one server as `ready`. On [one machine for everything](/start/install/#one-machine-for-everything), the machine of the control plane is that server already. Otherwise, add one as [Add a server](/start/install/#add-a-server) says.

Public images, from Docker Hub or another public registry, need no setting. For a private registry, add its credentials under **Organization**, **Registries** first.

## 1. Create a project and an environment

Applications live in an environment, inside a project. Shipkeep creates neither for you.

1. Open **Projects**, then **New project**. Give it a **Name** and an **Identifier**, such as `storefront`, then **Create project**.
2. On the project's page, open **New environment**. Name it, for example `production`.
   - Tick **Protected: only administrators deploy and set secrets** for an environment where only administrators should deploy.
   - Then **Create environment**.

## 2. Create the application

1. Open **Applications**, then **New application**. Choose the environment in the list at the top, then **From a shipkeep.yml** and **Paste the file**.
2. The environment's **Resources** tab opens, with a `shipkeep.yml` to start from:

   ```yaml
   version: 1
   name: my-app
   build:
     type: image
     image: nginx:1.27
   run:
     port: 80
     healthcheck:
       path: /
   ```

   - `name` is the application's name in its environment: 3 to 40 lowercase letters, digits and dashes.
   - `run.port` is the port the container listens on.
   - `run.healthcheck.path` is checked on each replica before traffic switches to it.

3. Select **Create application**. The file is checked first, and the reasons appear under **The configuration is invalid** if it is not valid.

The application now exists, as **never deployed**. Creating it does not deploy it.

## 3. Deploy it

Open the application, then select **Deploy**. Each step shows as it happens. On the **Deployments** tab, **Details** opens the deployment's timeline, with the action each server ran:

1. **Queued**: the image tag is resolved to a digest.
2. **Placement**: the replicas are placed on servers with room for them.
3. **Starting**: each server pulls the image and starts the containers.
4. **Health check**: each replica answers on `run.healthcheck.path`.
5. **Switchover**: the routes switch to the new replicas. Then **Draining** stops the previous ones, if any.

The status turns **live** once it succeeded. If a step fails, the deployment says why, and the release before it keeps serving.

## 4. Give it a domain

1. On a public DNS server, point the domain at the server's public address, with an `A` or `AAAA` record. The server must answer on ports 80 and 443.
2. On **Servers**, an administrator records that address under **Public address**, with **Set**. The application's **Domains** section then tells whether the domain points at it.
3. On the application's **Configuration** tab, select **Edit shipkeep.yml** and add the domain:

   ```yaml
   domains:
     - shop.example.com
   ```

   Then **Review changes**, **Save configuration**, and **Deploy**. Saving alone does not apply a change.

Caddy obtains the certificate from Let's Encrypt once the domain answers, and renews it about 30 days before it expires. Wildcard domains are not supported yet.

## 5. Add secrets

Secrets belong to the environment, and an application names the ones it uses:

1. On the environment's page, open **Variables and secrets**. Give a **Name**, such as `DATABASE_URL`, and a **Value**, then **Set secret**. A value can never be read back, only replaced.
2. List the names in `shipkeep.yml`, save, and deploy:

   ```yaml
   secrets:
     - DATABASE_URL
   ```

Each name becomes an environment variable of the container. A deployment that names a secret with no value is refused before it starts.

## 6. Roll back, stop, or put it in maintenance

- **Roll back**: on the **Deployments** tab, **Roll back** deploys an earlier release that succeeded, the same way.
- **Stop**: on the **Configuration** tab, the **Danger zone** has **Stop**, then **Stop it now**. It removes the application's routes and replicas, and frees their room on the servers. Its releases stay, and **Start** deploys the last one again.
- **Maintenance**: in the same place, **Enable**, then **Enable it now**, shows visitors a maintenance page while the replicas keep running. Deploying waits until you **Disable** it.

## With the CLI

The `shipkeep` CLI does the same from a terminal or a CI job.

1. **Create an API token.** On your account page, open **API tokens**, then **Create API token**.
   - Choose the organization, the project and the environment.
   - Tick **Read environments, applications and deployments**, **Change applications and deploy them**, and **Set and remove secrets**.
   - The token is shown once. Copy it and keep it in a password manager.
2. **Sign in.** The token is read from a prompt or from standard input, never from a flag:

   ```sh
   shipkeep login --url https://shipkeep.example.com
   ```

3. **Write a `shipkeep.yml`**, or let `init` write one:

   ```sh
   shipkeep init --name my-app --image nginx:1.27 --port 80
   ```

4. **Deploy.** The organization, project and environment are given as identifiers.
   - The web UI does not show them yet. They are in the browser's address bar on the environment's page: `/orgs/<organization>/projects/<project>/environments/<environment>`.
   - Instead of flags, you can set `SHIPKEEP_ORG`, `SHIPKEEP_PROJECT` and `SHIPKEEP_ENV`.

   ```sh
   shipkeep deploy --org <organization> --project <project> --env <environment>
   ```

   `deploy` creates the application the first time and saves its configuration after that, then deploys it and follows it until it succeeds or fails.

5. **Follow and roll back.** These commands need the same identifiers as `deploy`, which saves only the address and the token. Set the three variables once in your shell, for example `export SHIPKEEP_ORG=… SHIPKEEP_PROJECT=… SHIPKEEP_ENV=…`, or pass `--org`, `--project` and `--env` to each.
   - `shipkeep status` lists the applications of the environment, with their last deployment and their running replicas.
   - `shipkeep rollback` returns to the last good deployment of an earlier release.
   - `shipkeep secrets set DATABASE_URL` reads the value from a hidden prompt or a pipe.

In automation, `SHIPKEEP_URL` and `SHIPKEEP_TOKEN` replace the saved login.
