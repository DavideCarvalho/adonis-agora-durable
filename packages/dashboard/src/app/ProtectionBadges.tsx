import type { ReactNode } from 'react';
import { Hint } from '../agora-kit/blocks/hint';
import { Badge } from '../agora-kit/ui/badge';
import type { ConsoleProtection, MessagesMode } from '../client/durable-client';
import { DatabaseIcon, EyeOffIcon, LockIcon, ShieldIcon } from './icons';

const DOCS = 'https://davidecarvalho.github.io/agora/docs/durable';
export const MESSAGES_DOCS = `${DOCS}/transports/encrypting-messages`;
export const STORE_DOCS = `${DOCS}/stores#encrypting-payloads-at-rest`;
export const REDACT_DOCS = `${DOCS}/observability/dashboard#redacting-payloads`;

/** How each messages mode reads in a badge, and what it means. */
const MODE_COPY: Record<MessagesMode, { label: string; means: string }> = {
  'tenant-key': {
    label: 'sealed (tenant key)',
    means: 'Encrypted and authenticated with a key per tenant, handed out by the control plane.',
  },
  'app-key': {
    label: 'sealed (app key)',
    means: "Encrypted and authenticated with a key derived from the app's APP_KEY.",
  },
  crypto: {
    label: 'sealed (crypto)',
    means: 'Encrypted and authenticated with a key held by @adonis-agora/crypto.',
  },
  secret: {
    label: 'signed only (secret)',
    means:
      'Signed with a shared secret: tampering is refused, but anyone who reads the broker reads the data.',
  },
  plain: {
    label: 'plain',
    means:
      'Neither encrypted nor signed: anyone who can reach the broker can read and inject them.',
  },
};

/** Weakest first: the badge names the weakest mode any transport uses, never more than that. */
const STRENGTH: MessagesMode[] = ['plain', 'secret', 'app-key', 'crypto', 'tenant-key'];

/** The badge label of a set of transports' modes: the weakest, or "sealed (mixed)" across seals. */
export function messagesLabel(protection: ConsoleProtection): string | undefined {
  const modes = new Set(protection.messages.map((m) => m.mode));
  if (modes.size === 0) return undefined;
  const weakest = STRENGTH.find((mode) => modes.has(mode)) as MessagesMode;
  if (weakest === 'plain' || weakest === 'secret' || modes.size === 1) {
    return MODE_COPY[weakest].label;
  }
  return 'sealed (mixed)';
}

/**
 * Whether the messages badge warns: a transport sends plain, or a sealing one still accepts plain
 * messages (anyone who can write to the broker can inject unsealed ones there).
 */
export function messagesWarn(protection: ConsoleProtection): boolean {
  return protection.messages.some((m) => m.mode === 'plain' || m.acceptPlain);
}

/** The store badge label, or undefined when the store is not known. */
export function storeLabel(protection: ConsoleProtection): string | undefined {
  const store = protection.store;
  if (!store) return undefined;
  if (!store.codec) return 'plain';
  return store.coverage === 'extended' ? 'encrypted (extended)' : 'encrypted (input/output)';
}

function messagesHint(protection: ConsoleProtection): string {
  const lines = protection.messages.map((m) => {
    const copy = MODE_COPY[m.mode];
    const plainToo =
      m.mode !== 'plain' && m.acceptPlain
        ? ' Also accepts plain messages, so anyone who can write to the broker can inject unsealed ones (set acceptPlain: false).'
        : '';
    return `${m.transport}: ${copy.label}. ${copy.means}${plainToo}`;
  });
  return `${lines.join('\n')}\nClick for the docs.`;
}

function storeHint(protection: ConsoleProtection): string {
  const store = protection.store;
  const body = !store?.codec
    ? 'The state store keeps run data as written: no codec encrypts it at rest.'
    : store.coverage === 'extended'
      ? 'The state store encrypts run and step input, output, errors, step logs and progress at rest. Search attributes stay clear.'
      : 'The state store encrypts run and step input and output at rest. Errors and step logs stay clear.';
  return `${body} The console shows it decrypted.\nClick for the docs.`;
}

function redactHint(protection: ConsoleProtection): string {
  const what = [protection.redact.run && 'runs', protection.redact.checkpoint && 'steps']
    .filter(Boolean)
    .join(' and ');
  return `This console's redact hooks hide fields of ${what} before they reach the browser. Hidden fields are marked.\nClick for the docs.`;
}

function LinkBadge({
  href,
  hint,
  tone,
  icon,
  testId,
  children,
}: {
  href: string;
  hint: string;
  tone: 'neutral' | 'warn';
  icon: ReactNode;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Hint label={hint}>
      <Badge
        variant={tone}
        data-testid={testId}
        render={<a href={href} target="_blank" rel="noreferrer noopener" />}
      >
        {icon}
        {children}
      </Badge>
    </Hint>
  );
}

/**
 * The header's protection badges: how the served app's broker messages are sealed, whether its
 * store encrypts at rest, and whether this console's `redact` hooks hide fields. Nothing renders
 * without a descriptor (an older server, or an app too old to report it).
 */
export function ProtectionBadges({
  protection,
  className,
}: {
  protection: ConsoleProtection | undefined;
  className?: string;
}) {
  if (!protection) return null;
  const messages = messagesLabel(protection);
  const store = storeLabel(protection);
  const redacting = protection.redact.run || protection.redact.checkpoint;
  if (!messages && !store && !redacting) return null;
  return (
    <div className={`items-center gap-1.5 ${className ?? 'flex'}`} data-testid="protection-badges">
      {messages && (
        <LinkBadge
          href={MESSAGES_DOCS}
          hint={messagesHint(protection)}
          tone={messagesWarn(protection) ? 'warn' : 'neutral'}
          icon={<ShieldIcon />}
          testId="protection-messages"
        >
          Messages: {messages}
        </LinkBadge>
      )}
      {store && (
        <LinkBadge
          href={STORE_DOCS}
          hint={storeHint(protection)}
          tone="neutral"
          icon={<DatabaseIcon />}
          testId="protection-store"
        >
          Store: {store}
        </LinkBadge>
      )}
      {redacting && (
        <LinkBadge
          href={REDACT_DOCS}
          hint={redactHint(protection)}
          tone="neutral"
          icon={<EyeOffIcon />}
          testId="protection-redact"
        >
          Redacted
        </LinkBadge>
      )}
    </div>
  );
}

/** What the run detail knows about a field: encrypted at rest, hidden by a redact hook. */
export interface FieldProtection {
  encrypted?: readonly string[] | undefined;
  redacted?: readonly string[] | undefined;
}

/** The lock and "hidden by redact" markers of one field (`input`, `output`, `error`, `events`). */
export function FieldMarks({ field, marks }: { field: string; marks?: FieldProtection }) {
  const encrypted = marks?.encrypted?.includes(field) ?? false;
  const redacted = marks?.redacted?.includes(field) ?? false;
  if (!encrypted && !redacted) return null;
  return (
    <span className="inline-flex items-center gap-1.5 normal-case tracking-normal">
      {encrypted && (
        <Hint label="Encrypted at rest; the console shows it decrypted">
          <span
            className="inline-flex text-dim"
            data-testid={`encrypted-${field}`}
            role="img"
            aria-label="Encrypted at rest; the console shows it decrypted"
          >
            <LockIcon width={11} height={11} />
          </span>
        </Hint>
      )}
      {redacted && (
        <Hint label="Hidden by this console's redact hook: the value shown is what the hook returned">
          <span
            className="inline-flex items-center gap-1 rounded border border-line px-1 text-[9.5px] text-dim"
            data-testid={`redacted-${field}`}
          >
            <EyeOffIcon width={10} height={10} />
            hidden by redact
          </span>
        </Hint>
      )}
    </span>
  );
}
