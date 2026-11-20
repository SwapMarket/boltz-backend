// Why a request failed authentication. The reason is only logged: every
// rejected client gets the same "unauthorized", so probing learns nothing
class AuthRejection {
  constructor(public readonly reason: string) {}
}

// Reads can be repeated harmlessly, and two identical ones within a second
// carry identical signatures, so only requests that change something are
// checked for replays
export const isReplayProtected = (method: string): boolean =>
  !['GET', 'HEAD', 'OPTIONS'].includes(method);

export default AuthRejection;
