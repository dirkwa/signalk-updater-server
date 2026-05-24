import { Alert } from 'reactstrap';

export function Logs() {
  return (
    <Alert color="info" className="mb-0">
      The Logs view is being ported in the next change. Until then, container logs are accessible
      via <code>journalctl --user -u signalk-server.service</code> over SSH.
    </Alert>
  );
}
