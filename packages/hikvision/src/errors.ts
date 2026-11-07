/**
 * Error from a Hikvision device.
 *
 * status 0   = the device could not be reached (network, timeout)
 * status 401 = wrong credentials (do NOT keep retrying: Hikvision locks the
 *              account after a few failed logins)
 * subStatus  = the device's own "subStatusCode", e.g. "employeeNoAlreadyExist"
 */
export class HikvisionError extends Error {
  readonly status: number;
  readonly body: string;
  readonly subStatus: string | undefined;

  constructor(message: string, status: number, body: string, subStatus?: string) {
    super(message);
    this.name = "HikvisionError";
    this.status = status;
    this.body = body;
    this.subStatus = subStatus;
  }
}
