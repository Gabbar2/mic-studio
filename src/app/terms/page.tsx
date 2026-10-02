import type { Metadata } from "next";
import Link from "next/link";
import LegalShell, { A, B, P, Section } from "@/components/LegalShell";
import {
  CONTACT_EMAIL,
  LEGAL_COUNTRY,
  LEGAL_EMIRATE,
  REFUND_WINDOW_DAYS,
  TRADING_NAME,
  sellerName,
} from "@/lib/legal";

export const metadata: Metadata = {
  title: "Terms — Mic Studio",
  description:
    "The rules for using Mic Studio: what you may generate, what you may not, and how credits work.",
};

/**
 * Terms of service.
 *
 * Written to be read, and structured so the section a payment processor cares
 * about — Prohibited uses — is near the top rather than buried at clause 14.
 * The prohibited list deliberately mirrors the categories card networks push
 * down through acquirers: likeness without consent, impersonation, face swaps,
 * deepfakes and synthetic voice. That is the section an application gets
 * judged on.
 *
 * NOT a substitute for a lawyer. The identity, governing law and refund
 * position now come from src/lib/legal.ts — fill LEGAL_NAME in before this
 * goes anywhere near a domain review.
 */
export default function TermsPage() {
  return (
    <LegalShell title="Terms of use">
        <p className="mt-8 text-sm leading-relaxed text-ink-300">
          {TRADING_NAME} (&ldquo;the service&rdquo;) is operated by{" "}
          <B>{sellerName()}</B>, a sole proprietor in the {LEGAL_COUNTRY}. It
          generates video from text and from files you provide. By using it you
          agree to what follows. If you do not, please do not use it.
        </p>

        <Section n="1" title="Who may use it">
          <P>
            You must be at least 16, and old enough where you live to enter a
            contract. If you use it for an organisation, you confirm you may
            bind that organisation to these terms.
          </P>
        </Section>

        <Section n="2" title="Prohibited uses" flag>
          <P>
            These are not guidelines. Breaking any of them ends your account
            immediately and without refund, and where the law requires it we
            will report the matter.
          </P>
          <P className="mt-3">
            <B>You must not generate, upload or attempt to generate:</B>
          </P>
          <Ban>
            Any real person&rsquo;s likeness without their explicit permission
            &mdash; this includes public figures, performers and politicians.
          </Ban>
          <Ban>
            Face swaps, deepfakes, or any material presenting a real person as
            saying or doing something they did not.
          </Ban>
          <Ban>
            Synthetic voice imitating a real person, or content designed to pass
            as authentic footage of a real event.
          </Ban>
          <Ban>
            Anything sexual involving a minor, or that sexualises a person who
            is or appears to be under 18. There is no exception to this and no
            context in which it is permitted.
          </Ban>
          <Ban>
            Sexually explicit or pornographic material of any kind.
          </Ban>
          <Ban>
            Content promoting violence, terrorism, self-harm, or hatred against
            people on the basis of race, religion, nationality, gender,
            disability or sexual orientation.
          </Ban>
          <Ban>
            Material intended to deceive &mdash; fake news footage, fabricated
            evidence, forged documents, or anything supporting fraud.
          </Ban>
          <Ban>
            Anything infringing someone else&rsquo;s copyright, trademark or
            other rights, including uploading material you do not have the
            right to use.
          </Ban>
          <Ban>
            Content that is illegal where you are, or in the United Arab
            Emirates.
          </Ban>
        </Section>

        <Section n="3" title="Files you upload">
          <P>
            Every upload requires you to confirm you have the right to use that
            file, and that any identifiable person in it has given permission
            for their likeness to be used. That confirmation is recorded with
            the file, the date, and the exact wording you agreed to.
          </P>
          <P>
            You keep ownership of what you upload. You grant us only the
            permission needed to run the service: to store the file, send it
            to whichever AI model generates your video, and show it back to
            you.
          </P>
        </Section>

        <Section n="4" title="What you generate">
          <P>
            As between you and us, generated videos are yours, including for
            commercial use. Two honest limits on that.
          </P>
          <P>
            The underlying model is operated by a third party and its own
            licence applies to the output as well. We pass through whatever
            rights we have and cannot grant more than we hold.
          </P>
          <P>
            AI output is not reliably unique. Another user with a similar prompt
            may receive similar material, and in most countries purely
            AI-generated work attracts limited or no copyright protection. If
            exclusivity matters to your use, take advice before relying on it.
          </P>
        </Section>

        <Section n="5" title="Moderation">
          <P>
            Content is filtered by our AI provider before generation. We may
            additionally review material, and we may remove content or suspend
            an account where we believe these terms have been broken.
          </P>
          <P>
            We do not monitor everything generated, and we do not claim to.
            Report anything that breaks these rules to{" "}
            <A href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</A> and we will act on it.
          </P>
        </Section>

        <Section n="6" title="Credits and payment">
          <P>
            Credits are bought in advance and spent on generation. They do not
            expire, and there is no subscription &mdash; nothing renews and
            nothing charges you again unless you buy more.
          </P>
          <P>
            You are charged only for a generation that succeeds. A failed one is
            refunded to your balance automatically.
          </P>
          <P>
            Unused credits are refundable for {REFUND_WINDOW_DAYS} days from
            purchase. Spent credits are not, because generating a video costs
            real money the moment it runs. The full terms are on the{" "}
            <Link
              href="/refunds"
              className="text-accent-400 underline underline-offset-2 transition hover:text-white"
            >
              refunds page
            </Link>
            , which forms part of these terms.
          </P>
          <P>
            Credits have no cash value outside the service and cannot be
            transferred or exchanged between accounts.
          </P>
        </Section>

        <Section n="7" title="Availability">
          <P>
            The service depends on third parties and is provided as-is. We do
            not promise it will be uninterrupted, that any particular output
            will meet your expectations, or that a feature marked{" "}
            <B>beta</B> works well &mdash; that label is a warning, and it is
            there because we would rather say so than let you find out.
          </P>
          <P>
            Generated files are served from provider storage and those links
            expire. Download anything you intend to keep.
          </P>
        </Section>

        <Section n="8" title="Ending it">
          <P>
            You can stop using the service at any time and ask us to delete your
            account and clips. We may suspend or close an account that breaks
            section 2, or that we reasonably believe is being used to defraud us
            or someone else.
          </P>
        </Section>

        <Section n="9" title="Liability">
          <P>
            To the extent the law allows, our total liability to you is limited
            to what you have paid us in the twelve months before the claim. We
            are not liable for lost profits, lost data or indirect losses.
          </P>
          <P>
            Nothing here limits liability that cannot lawfully be limited.
          </P>
        </Section>

        <Section n="10" title="Governing law">
          <P>
            These terms are governed by the laws of the {LEGAL_COUNTRY}, and
            the courts of {LEGAL_EMIRATE} have jurisdiction over any dispute.
          </P>
          <P>
            If you are a consumer, this does not deprive you of the protection
            of the mandatory consumer law of the country you live in.
          </P>
        </Section>

        <Section n="11" title="Changes">
          <P>
            If these terms change in a way that materially affects you, the date
            at the top changes and anyone with an account is emailed. Continuing
            to use the service afterwards means accepting the new version.
          </P>
        </Section>

        <p className="mt-12 border-t border-ink-800 pt-6 text-sm leading-relaxed text-ink-400">
          {sellerName()} &middot;{" "}
          <A href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</A>. How your data
          is handled is set out in the{" "}
          <Link
            href="/privacy"
            className="text-accent-400 underline underline-offset-2 transition hover:text-white"
          >
            privacy policy
          </Link>
          .
        </p>
    </LegalShell>
  );
}




function Ban({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex gap-2.5 border-l-2 border-rose-500/40 pl-3 text-sm leading-relaxed text-ink-300">
      {children}
    </p>
  );
}

