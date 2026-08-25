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
export const MUTABLE_MAIL_FLAGS = MAIL_FLAGS.UNREAD;

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
    if (!enabled) {
        delete result.flags;
        return result;
    }
    result.flags = Number(result.flags ?? 0);
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
    add: number;
    remove: number;
};

export type MailFlagFilter = {
    mask: number;
    state: 'set' | 'unset';
};

export const parseMailFlagFilter = (
    bitValue: string | undefined,
    stateValue: string | undefined,
): MailFlagFilter | undefined | null => {
    if (bitValue === undefined && stateValue === undefined) return undefined;
    if (!bitValue || !/^\d+$/.test(bitValue)) return null;
    const bit = Number(bitValue);
    if (!Number.isInteger(bit) || bit < 0 || bit > 30) return null;
    if (stateValue !== 'set' && stateValue !== 'unset') return null;
    return { mask: 1 << bit, state: stateValue };
};

export const parseMailFlagUpdate = (value: unknown): MailFlagUpdate | null => {
    if (!value || typeof value !== 'object') return null;
    const body = value as Record<string, unknown>;
    if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 100) return null;
    if (body.ids.some(id => typeof id !== 'number')) return null;

    const ids = [...new Set(body.ids.map(Number))];
    if (ids.some(id => !Number.isInteger(id) || id <= 0)) return null;

    if (body.add !== undefined && typeof body.add !== 'number') return null;
    if (body.remove !== undefined && typeof body.remove !== 'number') return null;
    const add = Number(body.add ?? 0);
    const remove = Number(body.remove ?? 0);
    if (!Number.isInteger(add) || !Number.isInteger(remove) || add < 0 || remove < 0) return null;
    if (add > MUTABLE_MAIL_FLAGS || remove > MUTABLE_MAIL_FLAGS) return null;
    if (((add | remove) & ~MUTABLE_MAIL_FLAGS) !== 0 || (add & remove) !== 0) return null;
    if (add === 0 && remove === 0) return null;

    return { ids, add, remove };
};
