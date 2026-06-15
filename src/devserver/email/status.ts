/**
 * The `i32` status `env::email_send` returns to the guest. Byte-identical to the
 * edge's `EmailStatus` (toil-backend `host/email.rs`, `#[repr(i32)]`) and the
 * guest `EmailStatus` enum (`server/globals/email.ts`). `Sent` and `Deduped` are
 * success; the rest say why it was not delivered and whether a retry could help.
 */
export enum EmailStatus {
    Sent = 0,
    /** No email config (or not enabled). */
    Disabled = 1,
    /** Per-process minute/day budget exhausted. Retriable later. */
    Budget = 2,
    /** Per-recipient hourly cap hit. Terminal for this recipient/window. */
    RecipientCapped = 3,
    /** An identical recent (recipient, purpose) send was collapsed. Treat as sent. */
    Deduped = 4,
    /** Saturated / queue full. Retriable; back off. */
    TryLater = 5,
    /** The recipient failed host-side validation (CRLF, multiple addresses, malformed). */
    BadRecipient = 6,
    /** The provider rejected the send, or transport failed after retries. Terminal. */
    ProviderError = 7,
}
