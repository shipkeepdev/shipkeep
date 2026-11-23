---
title: Introduction
description: Shipkeep deploys applications on servers you own, without leaving the root key in a web panel.
---

Shipkeep is a self-hosted platform that deploys applications to servers you own. You describe each application in a `shipkeep.yml` file, and Shipkeep places it on your servers, routes its domain over HTTPS, and keeps a history of its releases to roll back to.

:::caution[A prerelease]
Shipkeep is in development. The prerelease [`v0.1.0-alpha.3`](https://github.com/shipkeepdev/shipkeep/releases/tag/v0.1.0-alpha.3) can be installed to try it, on servers you can afford to lose. It has run end to end on test machines, not yet on a real server with a public certificate. The [README](https://github.com/shipkeepdev/shipkeep#what-works-today) lists what works today.
:::

## How it works

A Shipkeep installation has two kinds of machines:

- **The control plane** holds the web UI, the API and the database. You install it once, with Docker Compose.
- **Servers** run your applications. Each one runs the Shipkeep agent, which connects out to the control plane over mutual TLS. The control plane never holds an SSH key to your servers.

One machine can be both, for a small installation.

The agent runs a closed list of typed actions, such as pulling an image, starting a container or setting a route. It talks to Docker and to Caddy through their APIs and never runs a shell command. If the control plane goes down, your applications and their routes keep working from the agent's own state.

## What you do with it

1. [Install](/start/install/) the control plane, and add a server.
2. Describe an application in `shipkeep.yml`:

   ```yaml
   # shipkeep.yml
   version: 1
   name: storefront
   build:
     type: image
     image: nginx:1.27
   run:
     port: 80
   ```

3. [Deploy it](/start/first-deployment/) from the web UI or with the `shipkeep` CLI, then follow each step until it is live.

Every change is recorded in the audit log. Anything destructive, such as deleting an application, asks you to confirm it by name.

## Where to go next

- [Install](/start/install/) the control plane, on one machine or on several.
- [First deployment](/start/first-deployment/), from the web UI or the CLI.
- [Concepts](/concepts/overview/): organizations, projects, environments, releases and deployments.
