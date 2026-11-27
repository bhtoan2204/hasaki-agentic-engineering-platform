/**
 * What a production error text says about itself: a crash (panic, fatal error, out of memory, a deadlock that is a bug)
 * or money. Pure; the Go port (go/internal/proderrors/classify.go) must agree on every vector of
 * go/internal/proderrors/testdata/classify-vectors.json. Go's RE2 has no lookaround, so every rule is "matches this
 * and does not match that" over plain patterns.
 */

/** Always a crash, whatever else the line says. */
const CRASH_STRONG =
  /\bfatal error:|runtime: out of memory|\boomkilled\b|outofmemoryerror|all goroutines are asleep/i;
/** A crash unless the line says it was recovered or is a retryable database deadlock. */
const CRASH_WEAK =
  /\bpanic\b|nil pointer|invalid memory address|index out of range|\bdeadlock\b|out of memory/i;
const RECOVERED =
  /recovered (from )?(a )?panic|panic (was |has been )?recovered|recovered panic|recovering from panic/i;
const DB_DEADLOCK =
  /deadlock found|deadlock detected|try restarting transaction|er_lock_deadlock|sqlstate[ =:(]*(40001|40p01)/i;

const MONEY_ALWAYS =
  /refund|hoàn tiền|reconcil|sign(ature)? not match|invalid sign|checksum|\bipn\b|\bcod\b|chargeback/i;
const MONEY_PHRASE =
  /duplicate (payment|transaction|order|charge|refund|callback)|double (charge|refund|payment|spend|debit)|amount (mismatch|not match|invalid)/i;
/** Words that are money only next to a money context. */
const MONEY_WORD = /\b(charge|capture|settle(d|ment)?|callback|webhook|amount)\b/i;
const MONEY_CONTEXT =
  /payment|order|transaction|wallet|thanh toán|đơn hàng|zalopay|momo|vnpay|paypal|stripe/i;

export const isCrash = (text: string) =>
  CRASH_STRONG.test(text) ||
  (CRASH_WEAK.test(text) && !RECOVERED.test(text) && !DB_DEADLOCK.test(text));

export const isMoney = (text: string) =>
  MONEY_ALWAYS.test(text) ||
  MONEY_PHRASE.test(text) ||
  (MONEY_WORD.test(text) && MONEY_CONTEXT.test(text));

/** The crash rule as SPL (`match` is PCRE, case sensitive unless told), over the field `txt`. */
export function crashSpl(fatalLevels: string) {
  const re = (r: RegExp) =>
    `match(txt,"(?i)${r.source.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`;
  return `if(lv IN (${fatalLevels}) OR ${re(CRASH_STRONG)} OR (${re(CRASH_WEAK)} AND NOT (${re(RECOVERED)} OR ${re(DB_DEADLOCK)})),1,0)`;
}
