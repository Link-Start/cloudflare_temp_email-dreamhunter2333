import { getBooleanValue } from './utils';

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

export enum MailState {
    ALL = 'all',
    UNREAD = 'unread',
    READ = 'read',
}

export type MailStateOption = {
    value: string;
    label_key?: string;
    label?: string;
    unread?: boolean;
    default?: boolean;
};

export type MailStateDefinition = MailStateOption & {
    filter?: { mask: number; set: boolean };
    mutation?: { add: number; remove: number };
};

const SYSTEM_MAIL_STATES: MailStateDefinition[] = [
    { value: MailState.ALL, label_key: 'allMail', default: true },
    {
        value: MailState.UNREAD,
        label_key: 'unread',
        unread: true,
        filter: { mask: MAIL_FLAGS.UNREAD, set: true },
        mutation: { add: MAIL_FLAGS.UNREAD, remove: 0 },
    },
    {
        value: MailState.READ,
        label_key: 'read',
        unread: false,
        filter: { mask: MAIL_FLAGS.UNREAD, set: false },
        mutation: { add: 0, remove: MAIL_FLAGS.UNREAD },
    },
];

export const getMailStateOptions = (
    customStates: MailStateDefinition[] = [],
): MailStateOption[] => {
    return [...SYSTEM_MAIL_STATES, ...customStates].map(state => {
        const { filter: _filter, mutation: _mutation, ...option } = state;
        return option;
    });
};

const getMailStateDefinition = (
    value: unknown,
    customStates: MailStateDefinition[] = [],
) => {
    if (typeof value !== 'string') return undefined;
    return [...SYSTEM_MAIL_STATES, ...customStates].find(state => state.value === value);
};

export const getCustomMailFlag = (slot: number): number => {
    if (!Number.isInteger(slot) || slot < 0 || slot >= CUSTOM_MAIL_FLAG_COUNT) {
        throw new Error("Invalid custom mail flag slot");
    }
    return 1 << (CUSTOM_MAIL_FLAG_OFFSET + slot);
};

export type CustomMailStateConfig = {
    slot: number;
    name: string;
};

const CUSTOM_MAIL_FLAGS_MASK = ((1 << CUSTOM_MAIL_FLAG_COUNT) - 1) << CUSTOM_MAIL_FLAG_OFFSET;

export const createCustomMailStateDefinitions = (
    configs: CustomMailStateConfig[],
): MailStateDefinition[] => {
    return configs.map(config => {
        const flag = getCustomMailFlag(config.slot);
        return {
            value: `custom:${config.slot}`,
            label: config.name,
            filter: { mask: flag, set: true },
            mutation: { add: flag, remove: CUSTOM_MAIL_FLAGS_MASK & ~flag },
        };
    });
};

export const serializeMailState = <T extends Record<string, unknown>>(
    row: T,
    env: Bindings,
): T => {
    const result = { ...row };
    const flags = Number(result.flags ?? 0);
    delete result.flags;
    if (!getBooleanValue(env.ENABLE_MAIL_FLAGS)) {
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

export type MailStateUpdate = {
    ids: number[];
    state: string;
    add: number;
    remove: number;
};

export type MailReadStatusQuery = {
    clause: string;
    params: string[];
};

export const getMailStateQuery = (
    value: string | undefined,
    column: 'flags' | 'rm.flags',
    customStates: MailStateDefinition[] = [],
): MailReadStatusQuery | undefined | null => {
    if (value === undefined) return undefined;
    const definition = getMailStateDefinition(value, customStates);
    if (!definition) return null;
    if (!definition.filter) return undefined;
    const operator = definition.filter.set ? '!=' : '=';
    return {
        clause: `(COALESCE(${column}, 0) & ?) ${operator} 0`,
        params: [String(definition.filter.mask)],
    };
};

const parseMailStateUpdate = (
    value: unknown,
    customStates: MailStateDefinition[] = [],
): MailStateUpdate | null => {
    if (!value || typeof value !== 'object') return null;
    const body = value as Record<string, unknown>;
    if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 100) return null;
    if (body.ids.some(id => typeof id !== 'number')) return null;

    const ids = [...new Set(body.ids.map(Number))];
    if (ids.some(id => !Number.isInteger(id) || id <= 0)) return null;

    const definition = getMailStateDefinition(body.state, customStates);
    if (!definition?.mutation) return null;
    return {
        ids,
        state: definition.value,
        add: definition.mutation.add,
        remove: definition.mutation.remove,
    };
};

const getMailStateUpdateExpression = (
    update: MailStateUpdate,
    column = 'flags',
): { expression: string; params: number[]; condition?: string; conditionParams?: number[] } => {
    return {
        expression: `((COALESCE(${column}, 0) | ?) & ~?)`,
        params: [update.add, update.remove],
        condition: `((COALESCE(${column}, 0) & ?) != ? OR (COALESCE(${column}, 0) & ?) != 0)`,
        conditionParams: [update.add, update.add, update.remove],
    };
};

type MailScope = {
    clause: string;
    params: (string | number)[];
};

export const applyMailStateUpdate = async (
    db: D1Database,
    env: Bindings,
    scope: MailScope,
    value: unknown,
    customStates: MailStateDefinition[] = [],
) => {
    const update = parseMailStateUpdate(value, customStates);
    if (!update) return null;

    const placeholders = update.ids.map(() => '?').join(',');
    const statusUpdate = getMailStateUpdateExpression(update);
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
        results: results.map(row => serializeMailState(row, env)),
    };
};
