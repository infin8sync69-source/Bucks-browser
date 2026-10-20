import { protocol } from 'electron';

/**
 * Must run before app.whenReady(). Makes ipfs:// ipns:// behave like https://
 * (origins per CID, fetch(), relative URLs, service-worker-free), gives the
 * chrome its own bucks:// origin, and each installed app its own bucks-app://<id> origin.
 */
export function registerSchemePrivileges() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'bucks',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true },
    },
    {
      scheme: 'ipfs',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, allowServiceWorkers: false },
    },
    {
      scheme: 'ipns',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, allowServiceWorkers: false },
    },
    {
      scheme: 'bucks-app',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true, allowServiceWorkers: false },
    },
  ]);
}
