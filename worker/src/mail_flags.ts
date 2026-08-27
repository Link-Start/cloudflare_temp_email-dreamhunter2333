export enum MailFlag {
    UNREAD = 0,
    FLAGGED = 1,
}

export enum MailState {
    ALL = 'all',
    UNREAD = 'unread',
    READ = 'read',
}

export type MailStateOption = {
    value: string;
    label_key: string;
    unread?: boolean;
    default?: boolean;
};

type MailStateDefinition = MailStateOption & {
    filter?: { flag: MailFlag; present: boolean };
};

const MAIL_STATES: MailStateDefinition[] = [
    { value: MailState.ALL, label_key: 'allMail', default: true },
    {
        value: MailState.UNREAD,
        label_key: 'unread',
        unread: true,
        filter: { flag: MailFlag.UNREAD, present: true },
    },
    {
        value: MailState.READ,
        label_key: 'read',
        unread: false,
        filter: { flag: MailFlag.UNREAD, present: false },
    },
];

export const getMailStateOptions = (): MailStateOption[] => {
    return MAIL_STATES.map(({ filter: _filter, ...option }) => option);
};

const getMailStateDefinition = (value: unknown): MailStateDefinition | undefined => {
    if (typeof value !== 'string') return undefined;
    return MAIL_STATES.find(state => state.value === value);
};

const isEnabled = (value: boolean | string | undefined): boolean => {
    return value === true || value === 'true';
};

export const isMailReadStatusEnabled = (env: Bindings): boolean => {
    return isEnabled(env.ENABLE_MAIL_READ_STATUS);
};

export const isMailFlaggedEnabled = (env: Bindings): boolean => {
    return isEnabled(env.ENABLE_MAIL_FLAGGED);
};

const isAnyMailFlagEnabled = (env: Bindings): boolean => {
    return isMailReadStatusEnabled(env) || isMailFlaggedEnabled(env);
};

export const serializeMailStates = async <T extends Record<string, unknown>>(
    db: D1Database,
    rows: T[],
    env: Bindings,
): Promise<T[]> => {
    const readStatusEnabled = isMailReadStatusEnabled(env);
    const flaggedEnabled = isMailFlaggedEnabled(env);
    if ((!readStatusEnabled && !flaggedEnabled) || rows.length === 0) return rows;

    const hasBoolean = (row: T, field: string) => {
        return [true, false, 0, 1].includes(row[field] as boolean | number);
    };
    const ids = [...new Set(rows
        .filter(row => (readStatusEnabled && !hasBoolean(row, 'unread'))
            || (flaggedEnabled && !hasBoolean(row, 'flagged')))
        .map(row => Number(row.id)))]
        .filter(id => Number.isInteger(id) && id > 0);
    if (ids.length === 0) {
        return rows.map(row => ({
            ...row,
            ...(readStatusEnabled ? { unread: Boolean(row.unread) } : {}),
            ...(flaggedEnabled ? { flagged: Boolean(row.flagged) } : {}),
        }));
    }

    const flags = [
        ...(readStatusEnabled ? [MailFlag.UNREAD] : []),
        ...(flaggedEnabled ? [MailFlag.FLAGGED] : []),
    ];
    const flagPlaceholders = flags.map(() => '?').join(',');
    const placeholders = ids.map(() => '?').join(',');
    const { results } = await db.prepare(
        `SELECT mf.mail_id, mf.flag, a.name AS address FROM mail_flags mf`
        + ` JOIN address a ON a.id = mf.address_id`
        + ` WHERE mf.flag IN (${flagPlaceholders}) AND mf.mail_id IN (${placeholders})`
    ).bind(...flags, ...ids).all<{
        mail_id: number;
        flag: number;
        address: string;
    }>();
    const mailKey = (id: unknown, address: unknown) => `${Number(id)}\0${String(address)}`;
    const unreadKeys = new Set(results
        .filter(row => row.flag === MailFlag.UNREAD)
        .map(row => mailKey(row.mail_id, row.address)));
    const flaggedKeys = new Set(results
        .filter(row => row.flag === MailFlag.FLAGGED)
        .map(row => mailKey(row.mail_id, row.address)));

    return rows.map(row => ({
        ...row,
        ...(readStatusEnabled ? {
            unread: hasBoolean(row, 'unread')
                ? Boolean(row.unread)
                : unreadKeys.has(mailKey(row.id, row.address)),
        } : {}),
        ...(flaggedEnabled ? {
            flagged: hasBoolean(row, 'flagged')
                ? Boolean(row.flagged)
                : flaggedKeys.has(mailKey(row.id, row.address)),
        } : {}),
    }));
};

export const serializeMailState = async <T extends Record<string, unknown>>(
    db: D1Database,
    row: T,
    env: Bindings,
): Promise<T> => {
    const [result] = await serializeMailStates(db, [row], env);
    return result;
};

export const initializeMailFlagsAfterInsert = async (
    db: D1Database,
    env: Bindings,
    mailId: number,
    address: string,
): Promise<void> => {
    if (!isMailReadStatusEnabled(env) || !Number.isInteger(mailId) || mailId <= 0) return;

    try {
        await db.prepare(
            `INSERT OR IGNORE INTO mail_flags (mail_id, address_id, flag)`
            + ` SELECT ?, id, ? FROM address WHERE name = ?`
        ).bind(mailId, MailFlag.UNREAD, address).run();
    } catch (error) {
        console.error(`Failed to initialize mail flags for mail ${mailId}`, error);
    }
};

export type MailStateQuery = {
    join: string;
    clause?: string;
    orderBy?: string;
    unread?: boolean;
    flagged?: boolean;
    params: number[];
};

export const getMailFlaggedQuery = (
    value: string | undefined,
    mailAlias: string,
    addressIdColumn: string,
): MailStateQuery | undefined | null => {
    if (value === undefined) return undefined;
    if (value !== 'true' && value !== 'false') return null;

    const present = value === 'true';
    return {
        join: ` ${present ? 'JOIN' : 'LEFT JOIN'} mail_flags mail_flagged_flags`
            + ` ON mail_flagged_flags.mail_id = ${mailAlias}.id`
            + ` AND mail_flagged_flags.address_id = ${addressIdColumn}`
            + ` AND mail_flagged_flags.flag = ?`,
        clause: present ? undefined : 'mail_flagged_flags.mail_id IS NULL',
        orderBy: present ? 'mail_flagged_flags.mail_id desc' : undefined,
        flagged: present,
        params: [MailFlag.FLAGGED],
    };
};

export const getMailStateQuery = (
    value: string | undefined,
    mailAlias: string,
    addressIdColumn: string,
): MailStateQuery | undefined | null => {
    if (value === undefined) return undefined;

    const definition = getMailStateDefinition(value);
    if (!definition) return null;
    if (!definition.filter) return undefined;

    const { flag, present } = definition.filter;
    return {
        join: ` ${present ? 'JOIN' : 'LEFT JOIN'} mail_flags mail_state_flags`
            + ` ON mail_state_flags.mail_id = ${mailAlias}.id`
            + ` AND mail_state_flags.address_id = ${addressIdColumn}`
            + ` AND mail_state_flags.flag = ?`,
        clause: present ? undefined : 'mail_state_flags.mail_id IS NULL',
        orderBy: present ? 'mail_state_flags.mail_id desc' : undefined,
        unread: definition.unread,
        params: [flag],
    };
};

type MailFlagUpdate = {
    ids: number[];
    body: Record<string, unknown>;
};

const parseMailFlagUpdate = (value: unknown): MailFlagUpdate | null => {
    if (!value || typeof value !== 'object') return null;

    const body = value as Record<string, unknown>;
    if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 100) return null;
    if (body.ids.some(id => typeof id !== 'number')) return null;

    const ids = [...new Set(body.ids.map(Number))];
    if (ids.some(id => !Number.isInteger(id) || id <= 0)) return null;

    return { ids, body };
};

type MailScope = {
    clause: string;
    params: (string | number)[];
};

const applyMailFlagUpdate = async (
    db: D1Database,
    scope: MailScope,
    ids: number[],
    flag: MailFlag,
    present: boolean,
    resultField: 'unread' | 'flagged',
) => {
    const placeholders = ids.map(() => '?').join(',');
    const targetWhere = `rm.id IN (${placeholders}) AND (${scope.clause})`;
    const mutation = present
        ? db.prepare(
            `INSERT OR IGNORE INTO mail_flags (mail_id, address_id, flag)`
            + ` SELECT rm.id, a.id, ? FROM raw_mails rm`
            + ` JOIN address a ON a.name = rm.address WHERE ${targetWhere}`
        ).bind(flag, ...ids, ...scope.params)
        : db.prepare(
            `DELETE FROM mail_flags WHERE flag = ? AND mail_id IN (`
            + `SELECT rm.id FROM raw_mails rm JOIN address a ON a.name = rm.address`
            + ` WHERE ${targetWhere})`
        ).bind(flag, ...ids, ...scope.params);

    const mutationResult = await mutation.run();
    if (!mutationResult.success) {
        return { success: false, changes: 0, results: [] };
    }

    const { results } = await db.prepare(
        `SELECT rm.id FROM raw_mails rm JOIN address a ON a.name = rm.address`
        + ` WHERE ${targetWhere}`
    ).bind(...ids, ...scope.params).all<{ id: number }>();

    return {
        success: true,
        changes: mutationResult.meta.changes ?? 0,
        results: results.map(row => ({ id: row.id, [resultField]: present })),
    };
};

export const applyMailStateUpdate = async (
    db: D1Database,
    scope: MailScope,
    value: unknown,
) => {
    const update = parseMailFlagUpdate(value);
    if (!update) return null;

    const definition = getMailStateDefinition(update.body.state);
    if (definition?.unread === undefined) return null;
    return await applyMailFlagUpdate(
        db, scope, update.ids, MailFlag.UNREAD, definition.unread, 'unread'
    );
};

export const applyMailFlaggedUpdate = async (
    db: D1Database,
    scope: MailScope,
    value: unknown,
) => {
    const update = parseMailFlagUpdate(value);
    if (!update || typeof update.body.flagged !== 'boolean') return null;
    return await applyMailFlagUpdate(
        db, scope, update.ids, MailFlag.FLAGGED, update.body.flagged, 'flagged'
    );
};

export const prepareRawMailDeleteStatements = (
    db: D1Database,
    env: Bindings,
    whereClause: string,
    params: (string | number)[],
): D1PreparedStatement[] => {
    const deleteMail = db.prepare(`DELETE FROM raw_mails WHERE ${whereClause}`).bind(...params);
    if (!isAnyMailFlagEnabled(env)) return [deleteMail];

    return [
        db.prepare(
            `DELETE FROM mail_flags WHERE mail_id IN (`
            + `SELECT id FROM raw_mails WHERE ${whereClause})`
        ).bind(...params),
        deleteMail,
    ];
};

export const deleteRawMails = async (
    db: D1Database,
    env: Bindings,
    whereClause: string,
    params: (string | number)[],
): Promise<D1Result> => {
    const statements = prepareRawMailDeleteStatements(db, env, whereClause, params);
    if (statements.length === 1) return await statements[0].run();

    const results = await db.batch(statements);
    return results[results.length - 1];
};

export const cleanupOrphanMailFlags = async (
    db: D1Database,
    env: Bindings,
    limit = 1000,
): Promise<number> => {
    if (!isAnyMailFlagEnabled(env) || !Number.isInteger(limit) || limit <= 0) return 0;

    const result = await db.prepare(
        `DELETE FROM mail_flags WHERE (mail_id, flag) IN (`
        + `SELECT mf.mail_id, mf.flag FROM mail_flags mf`
        + ` LEFT JOIN raw_mails rm ON rm.id = mf.mail_id`
        + ` LEFT JOIN address a ON a.id = mf.address_id AND a.name = rm.address`
        + ` WHERE rm.id IS NULL OR a.id IS NULL LIMIT ?)`
    ).bind(limit).run();
    return result.meta.changes ?? 0;
};
