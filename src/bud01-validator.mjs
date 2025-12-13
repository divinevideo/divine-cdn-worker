// ABOUTME: BUD-01 Blossom auth event validation (expiration, action, created_at, server)
// ABOUTME: Validates Nostr event tags per Blossom spec beyond signature verification

/**
 * Validate a Nostr event for BUD-01 compliance
 *
 * @param {object} event - The Nostr event to validate
 * @param {object} options - Validation options
 * @param {string} options.action - Expected action (upload, get, list, delete)
 * @param {string} [options.serverHost] - Server hostname for server tag validation
 * @returns {{valid: boolean, error?: string, message?: string}}
 */
export function validateBud01Event(event, options = {}) {
  const { action, serverHost } = options;
  const now = Math.floor(Date.now() / 1000);
  const CLOCK_SKEW_TOLERANCE = 60; // 60 seconds tolerance for clock skew
  const EXPIRATION_GRACE_PERIOD = 300; // 5 minutes grace for slow uploads

  // Validate kind is 24242 (Blossom, not NIP-98's 27235)
  if (event.kind !== 24242) {
    return {
      valid: false,
      error: 'invalid_kind',
      message: `Invalid event kind: ${event.kind}. Expected 24242 (Blossom BUD-01), got ${event.kind === 27235 ? 'NIP-98' : 'unknown'}`
    };
  }

  // Extract tags
  const tags = event.tags || [];
  const expirationTag = tags.find(t => t[0] === 'expiration');
  const actionTag = tags.find(t => t[0] === 't');
  const serverTag = tags.find(t => t[0] === 'server');

  // Validate expiration tag exists
  if (!expirationTag || !expirationTag[1]) {
    return {
      valid: false,
      error: 'missing_expiration',
      message: 'Missing required expiration tag per BUD-01'
    };
  }

  // Validate expiration format
  const expiration = parseInt(expirationTag[1], 10);
  if (isNaN(expiration)) {
    return {
      valid: false,
      error: 'invalid_expiration',
      message: 'Invalid expiration format: must be unix timestamp'
    };
  }

  // Validate expiration (with grace period for slow uploads)
  if (expiration <= now - EXPIRATION_GRACE_PERIOD) {
    return {
      valid: false,
      error: 'expired',
      message: `Event has expired at ${new Date(expiration * 1000).toISOString()} (grace period: ${EXPIRATION_GRACE_PERIOD}s)`
    };
  }

  // Validate created_at is not too far in the future (allow small clock skew)
  if (event.created_at > now + CLOCK_SKEW_TOLERANCE) {
    return {
      valid: false,
      error: 'future_created_at',
      message: `Event created_at is in the future: ${new Date(event.created_at * 1000).toISOString()}`
    };
  }

  // Validate action tag exists
  if (!actionTag || !actionTag[1]) {
    return {
      valid: false,
      error: 'missing_action',
      message: 'Missing required action (t) tag per BUD-01'
    };
  }

  // Validate action matches expected action
  const eventAction = actionTag[1];
  if (action && eventAction !== action) {
    return {
      valid: false,
      error: 'action_mismatch',
      message: `Action mismatch: expected '${action}' but got '${eventAction}'`
    };
  }

  // Validate server tag if present
  if (serverTag && serverTag[1] && serverHost) {
    const serverUrl = serverTag[1];
    try {
      const url = new URL(serverUrl);
      if (url.hostname !== serverHost) {
        return {
          valid: false,
          error: 'server_mismatch',
          message: `Server mismatch: event scoped to '${url.hostname}' but this is '${serverHost}'`
        };
      }
    } catch (e) {
      // If server tag is not a valid URL, check if it matches hostname directly
      if (serverUrl !== serverHost && !serverUrl.includes(serverHost)) {
        return {
          valid: false,
          error: 'server_mismatch',
          message: `Server mismatch: event scoped to '${serverUrl}' but this is '${serverHost}'`
        };
      }
    }
  }

  return { valid: true };
}
