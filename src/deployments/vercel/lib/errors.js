// Error types shared across the sync functions.
//
// SyncError   — an intended HTTP failure (bad input, auth, capacity). Carries
//               its status code; lib/http.js's withErrors turns it into the
//               response.
// StoreError  — a store-layer failure identified by `code` (EHASH, ESIZE,
//               ETOOLARGE, ...); withErrors maps codes to statuses.

export class SyncError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.name = 'SyncError';
    this.status = status;
    if (extra) Object.assign(this, extra);
  }
}

export class StoreError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'StoreError';
    this.code = code;
  }
}
