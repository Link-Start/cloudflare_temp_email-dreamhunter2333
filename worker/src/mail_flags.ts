export const MAIL_FLAGS = {
    UNREAD: 1 << 0,
    ANSWERED: 1 << 1,
    FLAGGED: 1 << 2,
    DELETED: 1 << 3,
    DRAFT: 1 << 4,
    JUNK: 1 << 5,
} as const;

export const CUSTOM_MAIL_FLAG_OFFSET = 10;
export const CUSTOM_MAIL_FLAG_COUNT = 10;

const MAIL_FLAG_MASKS = {
    unread: MAIL_FLAGS.UNREAD,
} as const;

type MailFlagName = keyof typeof MAIL_FLAG_MASKS;
type MailFlagAction = 'set' | 'clear' | 'toggle';

const isMailFlagName = (value: unknown): value is MailFlagName => {
    return typeof value === 'string'
        && Object.prototype.hasOwnProperty.call(MAIL_FLAG_MASKS, value);
};

export const getCustomMailFlag = (slot: number): number => {
    if (!Number.isInteger(slot) || slot < 0 || slot >= CUSTOM_MAIL_FLAG_COUNT) {
        throw new Error("Invalid custom mail flag slot");
    }
    return 1 << (CUSTOM_MAIL_FLAG_OFFSET + slot);
};

export const serializeMailFlags = <T extends Record<string, unknown>>(
    row: T,
    enabled: boolean,
): T => {
    const result = { ...row };
    const flags = Number(result.flags ?? 0);
    delete result.flags;
    if (!enabled) {
        return result;
    }
    result.mail_flags = {
        unread: (flags & MAIL_FLAGS.UNREAD) !== 0,
    };
    return result;
};

export const resolveInitialMailFlags = async (
    enabled: boolean,
    _env: Bindings,
    _address: string,
    _parsedEmailContext: ParsedEmailContext,
): Promise<number | null> => {
    if (!enabled) return null;
    return MAIL_FLAGS.UNREAD;
};

type InsertRawMailParams = {
    source: string;
    address: string;
    content: string | ArrayBuffer;
    contentColumn: 'raw' | 'raw_blob';
    messageId: string | null;
    flags: number | null;
};

export const insertRawMail = async (
    db: D1Database,
    params: InsertRawMailParams,
) => {
    const { source, address, content, contentColumn, messageId, flags } = params;
    if (flags === null) {
        return db.prepare(
            `INSERT INTO raw_mails (source, address, ${contentColumn}, message_id) VALUES (?, ?, ?, ?)`
        ).bind(source, address, content, messageId).run();
    }
    return db.prepare(
        `INSERT INTO raw_mails (source, address, ${contentColumn}, message_id, flags) VALUES (?, ?, ?, ?, ?)`
    ).bind(source, address, content, messageId, flags).run();
};

export type MailFlagUpdate = {
    ids: number[];
    flag: MailFlagName;
    mask: number;
    action: MailFlagAction;
};

export type MailFlagFilter = {
    mask: number;
    state: 'set' | 'unset';
};

export const parseMailFlagFilter = (
    flagValue: string | undefined,
    stateValue: string | undefined,
): MailFlagFilter | undefined | null => {
    if (flagValue === undefined && stateValue === undefined) return undefined;
    if (!isMailFlagName(flagValue)) return null;
    if (stateValue !== 'set' && stateValue !== 'unset') return null;
    return { mask: MAIL_FLAG_MASKS[flagValue], state: stateValue };
};

export const parseReadStatusFilter = (
    value: string | undefined,
): MailFlagFilter | undefined | null => {
    if (value === undefined || value === 'all') return undefined;
    if (value === 'unread') return { mask: MAIL_FLAGS.UNREAD, state: 'set' };
    if (value === 'read') return { mask: MAIL_FLAGS.UNREAD, state: 'unset' };
    return null;
};

export const parseMailFlagUpdate = (value: unknown): MailFlagUpdate | null => {
    if (!value || typeof value !== 'object') return null;
    const body = value as Record<string, unknown>;
    if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 100) return null;
    if (body.ids.some(id => typeof id !== 'number')) return null;

    const ids = [...new Set(body.ids.map(Number))];
    if (ids.some(id => !Number.isInteger(id) || id <= 0)) return null;

    if (!isMailFlagName(body.flag)) return null;
    if (body.action !== 'set' && body.action !== 'clear' && body.action !== 'toggle') return null;

    const flag = body.flag;
    return { ids, flag, mask: MAIL_FLAG_MASKS[flag], action: body.action };
};

export const getMailFlagUpdateExpression = (
    update: MailFlagUpdate,
    column = 'flags',
): { expression: string; params: number[]; condition?: string; conditionParams?: number[] } => {
    if (update.action === 'set') {
        return {
            expression: `(COALESCE(${column}, 0) | ?)`,
            params: [update.mask],
            condition: `(COALESCE(${column}, 0) & ?) = 0`,
            conditionParams: [update.mask],
        };
    }
    if (update.action === 'clear') {
        return {
            expression: `(COALESCE(${column}, 0) & ~?)`,
            params: [update.mask],
            condition: `(COALESCE(${column}, 0) & ?) != 0`,
            conditionParams: [update.mask],
        };
    }
    return {
        expression: `((COALESCE(${column}, 0) | ?) - (COALESCE(${column}, 0) & ?))`,
        params: [update.mask, update.mask],
    };
};
