import { verifyPersonalMessageSignature } from '@mysten/sui/verify';

/**
 * Sign-In With Sui — the identity half of Rill's authorization server.
 *
 * Rill has no passwords, no email, and no user table, and it should not grow one: the only identity
 * that means anything here is a Sui address, because that is what owns an `AgentWallet` on-chain and
 * therefore what a published skill must be scoped to. So "log in" is exactly one action: prove
 * control of an address by signing a server-generated message with a browser wallet.
 *
 * Two properties worth stating because they are easy to lose in a refactor:
 *
 * 1. **The server generates the message; the browser signs it verbatim.** Nothing reconstructs the
 *    string from parts on the other side. A reconstruction would have to agree byte-for-byte on
 *    field order, spacing, and timestamp format forever — and the failure mode of disagreeing is a
 *    signature that verifies against a message the user never actually saw.
 * 2. **The address is derived from the signature, never taken from the request body.** We do not ask
 *    "did address X sign this?" (a claim the caller controls) but "which address signed this exact
 *    nonce?" (a fact only the key holder can produce). The nonce is single-use, so a signature
 *    captured from one authorize flow cannot open another.
 */

export interface SignInMessageInput {
  /** Host the user is authorizing at, shown first so the wallet prompt names it. */
  domain: string;
  /** Human name of the agent client asking for access, from its DCR registration. */
  clientName: string;
  /** The protected resource the resulting token will be bound to. */
  resource: string;
  /** Space-delimited scopes being granted. */
  scope: string;
  /** Single-use, per-request. This is what makes the signature non-replayable. */
  nonce: string;
  /** ISO-8601. */
  issuedAt: string;
  /** ISO-8601 — the same instant the parked authorize request expires. */
  expiresAt: string;
}

/**
 * The exact bytes the wallet will display and sign. Written to be readable in a wallet popup, where
 * the user's only defence against a malicious prompt is being able to understand what they are
 * signing — hence the plain statement of what this does and does not grant.
 */
export function buildSignInMessage(input: SignInMessageInput): string {
  return [
    `${input.domain} wants you to sign in with your Sui account.`,
    '',
    `This authorizes "${input.clientName}" to build Rill transactions for you.`,
    '',
    'This signature is a login only. It moves no funds, approves no transaction, and grants no',
    'spending authority — every spend is separately bounded by your on-chain agent wallet, and',
    'Rill never holds your private key.',
    '',
    `Resource: ${input.resource}`,
    `Scope: ${input.scope}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
    `Expires At: ${input.expiresAt}`,
  ].join('\n');
}

/** Raised for every rejection so the route layer maps one type to one generic client error. */
export class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignInError';
  }
}

/**
 * Verify a personal-message signature and return the Sui address that produced it.
 *
 * Delegates the cryptography to `@mysten/sui`'s `verifyPersonalMessageSignature`, which handles
 * every signature scheme an ordinary Sui wallet can present (Ed25519, Secp256k1, Secp256r1, and
 * multisig) and applies the personal-message intent prefix — signing raw bytes without that prefix
 * is what makes a "sign this login" flow forgeable into a transaction signature.
 *
 * zkLogin signatures additionally need a client for JWK lookup and are deliberately NOT accepted
 * here: that lookup is a network call whose failure is indistinguishable, at this layer, from an
 * invalid signature, and a login that fails open on a network blip is worse than one that does not
 * support zkLogin yet.
 */
export async function verifySignInSignature(message: string, signature: string): Promise<string> {
  if (typeof signature !== 'string' || signature.trim() === '') {
    throw new SignInError('A wallet signature is required.');
  }

  let address: string;
  try {
    const publicKey = await verifyPersonalMessageSignature(
      new TextEncoder().encode(message),
      signature.trim(),
    );
    address = publicKey.toSuiAddress();
  } catch (err) {
    // The underlying error can name the scheme, byte lengths, or parse offsets. None of that helps
    // a legitimate user and all of it helps someone probing the endpoint, so it is logged and the
    // caller gets one stable rejection — the same posture `/api/audit/:blobId` already takes.
    console.error('[siws] signature verification failed:', err instanceof Error ? err.message : err);
    throw new SignInError('Signature verification failed.');
  }

  if (!/^0x[0-9a-f]{64}$/.test(address)) {
    throw new SignInError('Signature verified but produced an unusable Sui address.');
  }
  return address;
}
