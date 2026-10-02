import type { Metadata } from "next";
import Link from "next/link";
import LegalShell, { A, B, P, Section } from "@/components/LegalShell";
import {
  CONTACT_EMAIL,
  REFUND_WINDOW_DAYS,
  sellerName,
} from "@/lib/legal";

export const metadata: Metadata = {
  title: "Refunds — Mic Studio",
  description:
    "Unused credits are refundable for 14 days. Failed generations are refunded automatically.",
};

/**
 * The refund policy, as its own page.
 *
 * It was a paragraph inside the Terms, which is where most people put it and
 * where Paddle's domain review will not accept it — Terms, Refunds and Privacy
 * each have to be reachable from site navigation in their own right.
 *
 * Splitting it turned out to be the honest thing anyway. A refund policy
 * someone has to hunt for inside clause 6 is a policy written to be complied
 * with rather than read.
 */
export default function RefundsPage() {
  return (
    <LegalShell title="Refund policy">
      <p className="mt-8 text-sm leading-relaxed text-ink-300">
        Short version: <B>if you have not spent it, you can have it back</B>{" "}
        within {REFUND_WINDOW_DAYS} days. If a generation fails, you never paid
        for it in the first place.
      </p>

      <Section title="Failed generations">
        <P>
          You are charged only for a video that succeeds. If one fails, the
          credits return to your balance automatically &mdash; there is nothing
          to claim and nobody to email. You will see the refund on your balance
          within seconds.
        </P>
      </Section>

      <Section title="Unused credits">
        <P>
          Credits you have bought but not spent are fully refundable for{" "}
          <B>{REFUND_WINDOW_DAYS} days</B> from the date of purchase. Email{" "}
          <A href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</A> from the
          address on your account and say how much you want back. No reason is
          required.
        </P>
        <P>
          The refund goes to the original payment method. Where only part of a
          purchase has been spent, the unspent part is refunded and the rest is
          not.
        </P>
      </Section>

      <Section title="Spent credits">
        <P>
          Credits already used to generate a video are not refundable, and the
          reason is straightforward: generating it cost real money the moment it
          ran, and that cost cannot be recovered. This is the same reason the
          price is shown on the button before you press it rather than
          afterwards.
        </P>
        <P>
          That is the rule, not a wall. If a video failed to arrive, arrived
          broken, or you were charged for something you did not get, write to us
          and it will be put right. We would rather fix a problem than win an
          argument about it.
        </P>
      </Section>

      <Section title="How long it takes">
        <P>
          Refunds are approved within 2 business days. Once approved, the money
          takes as long as your bank takes &mdash; typically 5 to 10 business
          days for a card, and that part is out of our hands.
        </P>
      </Section>

      <Section title="Chargebacks">
        <P>
          If something has gone wrong, please email first. A chargeback costs us
          a fee whatever the outcome and takes weeks to resolve, whereas a
          refund takes minutes. We have never refused a reasonable request and
          do not intend to start.
        </P>
      </Section>

      <Section title="Statutory rights">
        <P>
          Nothing here removes rights you have under the consumer law that
          applies to you. Where that law gives you more than this policy does,
          the law wins.
        </P>
        <P>
          Payments are processed by our payment provider, who acts as merchant
          of record for the sale. Their own buyer protection applies alongside
          this policy, and a refund can be requested through either of us.
        </P>
      </Section>

      <p className="mt-10 text-sm leading-relaxed text-ink-300">
        Refunds and anything else: <A href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</A>.
        This policy forms part of the{" "}
        <Link
          href="/terms"
          className="text-accent-400 underline underline-offset-2 transition hover:text-white"
        >
          terms of use
        </Link>{" "}
        of {sellerName()}.
      </p>
    </LegalShell>
  );
}
