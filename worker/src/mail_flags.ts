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

type MailReadStatusAction = 'read' | 'unread' | 'toggle';

export const getCustomMailFlag = (slot: number): number => {
    if (!Number.isInteger(slot) || slot < 0 || slot >= CUSTOM_MAIL_FLAG_COUNT) {
        throw new Error("Invalid custom mail flag slot");
    }
    return 1 << (CUSTOM_MAIL_FLAG_OFFSET + slot);
};

export const serializeMailState = <T extends Record<string, unknown>>(
    row: T,
    enabled: boolean,
): T => {
    const result = { ...row };
    const flags = Number(result.flags ?? 0);
    delete result.flags;
    if (!enabled) {
        return result;
    }
    result.unread = (flags & MAIL_FLAGS.UNREAD) !== 0;
    return result;
};

const resolveInitialMailFlags = async (
    _env: Bindings,
    _address: string,
    _parsedEmailContext: ParsedEmailContext,
): Promise<number> => {
    return MAIL_FLAGS.UNREAD;
};

export const updateInitialMailFlags = async (
    db: D1Database,
    enabled: boolean,
    mailId: number,
    env: Bindings,
    address: string,
    parsedEmailContext: ParsedEmailContext,
) => {
    if (!enabled || !Number.isInteger(mailId) || mailId <= 0) return;
    const flags = await resolveInitialMailFlags(env, address, parsedEmailContext);
    await db.prepare(`UPDATE raw_mails SET flags = ? WHERE id = ?`).bind(flags, mailId).run();
};

export type MailReadStatusUpdate = {
    ids: number[];
    mask: number;
    action: MailReadStatusAction;
};

export type MailReadStatusQuery = {
    clause: string;
    params: string[];
};

export const getReadStatusQuery = (
    value: string | undefined,
    column: 'flags' | 'rm.flags',
): MailReadStatusQuery | undefined | null => {
    if (value === undefined || value === 'all') return undefined;
    if (value === 'unread') {
        return { clause: `(COALESCE(${column}, 0) & ?) != 0`, params: [String(MAIL_FLAGS.UNREAD)] };
    }
    if (value === 'read') {
        return { clause: `(COALESCE(${column}, 0) & ?) = 0`, params: [String(MAIL_FLAGS.UNREAD)] };
    }
    return null;
};

const parseMailReadStatusUpdate = (value: unknown): MailReadStatusUpdate | null => {
    if (!value || typeof value !== 'object') return null;
    const body = value as Record<string, unknown>;
    if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 100) return null;
    if (body.ids.some(id => typeof id !== 'number')) return null;

    const ids = [...new Set(body.ids.map(Number))];
    if (ids.some(id => !Number.isInteger(id) || id <= 0)) return null;

    if (body.action !== 'read' && body.action !== 'unread' && body.action !== 'toggle') return null;

    return { ids, mask: MAIL_FLAGS.UNREAD, action: body.action };
};

const getMailReadStatusUpdateExpression = (
    update: MailReadStatusUpdate,
    column = 'flags',
): { expression: string; params: number[]; condition?: string; conditionParams?: number[] } => {
    if (update.action === 'unread') {
        return {
            expression: `(COALESCE(${column}, 0) | ?)`,
            params: [update.mask],
            condition: `(COALESCE(${column}, 0) & ?) = 0`,
            conditionParams: [update.mask],
        };
    }
    if (update.action === 'read') {
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

type MailScope = {
    clause: string;
    params: (string | number)[];
};

export const applyMailReadStatusUpdate = async (
    db: D1Database,
    scope: MailScope,
    value: unknown,
) => {
    const update = parseMailReadStatusUpdate(value);
    if (!update) return null;

    const placeholders = update.ids.map(() => '?').join(',');
    const statusUpdate = getMailReadStatusUpdateExpression(update);
    const condition = statusUpdate.condition ? ` AND ${statusUpdate.condition}` : '';
    const result = await db.prepare(
        `UPDATE raw_mails SET flags = ${statusUpdate.expression}`
        + ` WHERE id IN (${placeholders}) AND (${scope.clause})${condition}`
    ).bind(
        ...statusUpdate.params,
        ...update.ids,
        ...scope.params,
        ...(statusUpdate.conditionParams ?? []),
    ).run();
    if (!result.success) return { success: false, changes: 0, results: [] };

    const { results } = await db.prepare(
        `SELECT id, flags FROM raw_mails`
        + ` WHERE id IN (${placeholders}) AND (${scope.clause})`
    ).bind(...update.ids, ...scope.params).all();
    return {
        success: true,
        changes: result.meta.changes ?? 0,
        results: results.map(row => serializeMailState(row, true)),
    };
};
