import { Context } from 'hono'

import i18n from '../i18n';
import { getBooleanValue } from '../utils';
import { handleMailListQuery, deleteAddressWithData, updateAddressUpdatedAt } from '../common'
import { resolveRawEmailRow } from '../gzip'
import { getSendBalanceState } from './send_balance';
import {
    getMailStateQuery,
    getMailFlaggedQuery,
    getMailStateOptions,
    applyMailStateUpdate,
    applyMailFlaggedUpdate,
    serializeMailState,
    deleteRawMails,
    isMailReadStatusEnabled,
    isMailFlaggedEnabled,
} from '../mail_flags';

const listMails = async (c: Context<HonoCustomType>) => {
    const { address } = c.get("jwtPayload")
    if (!address) {
        return c.json({ "error": "No address" }, 400)
    }
    const { limit, offset, mail_state, flagged } = c.req.query();
    if (Number.parseInt(offset) <= 0) updateAddressUpdatedAt(c, address);
    const stateQuery = getMailStateQuery(mail_state, 'rm', 'a.id');
    const flaggedQuery = getMailFlaggedQuery(flagged, 'rm', 'a.id');
    if (stateQuery === null) return c.json({ error: "Invalid mail state filter" }, 400);
    if (flaggedQuery === null) return c.json({ error: "Invalid flagged filter" }, 400);
    if (stateQuery && !isMailReadStatusEnabled(c.env)) {
        return c.json({ error: "Mail read status is disabled" }, 403);
    }
    if (flaggedQuery && !isMailFlaggedEnabled(c.env)) {
        return c.json({ error: "Flagged mail is disabled" }, 403);
    }

    if (!stateQuery && !flaggedQuery) {
        return await handleMailListQuery(c,
            `SELECT * FROM raw_mails WHERE address = ?`,
            `SELECT count(*) as count FROM raw_mails WHERE address = ?`,
            [address], limit, offset
        );
    }

    const filters = [`rm.address = ?`];
    if (stateQuery?.clause) filters.push(stateQuery.clause);
    if (flaggedQuery?.clause) filters.push(flaggedQuery.clause);
    const fromQuery = ` FROM raw_mails rm`
        + ` JOIN address a ON a.name = rm.address`
        + (stateQuery?.join ?? '')
        + (flaggedQuery?.join ?? '')
        + ` WHERE ${filters.join(' AND ')}`;
    const unreadSelect = stateQuery?.unread === undefined
        ? ''
        : `, ${stateQuery.unread ? 1 : 0} AS unread`;
    const flaggedSelect = flaggedQuery?.flagged === undefined
        ? ''
        : `, ${flaggedQuery.flagged ? 1 : 0} AS flagged`;
    return await handleMailListQuery(c,
        `SELECT rm.*${unreadSelect}${flaggedSelect}${fromQuery}`,
        `SELECT count(*) as count${fromQuery}`,
        [...(stateQuery?.params ?? []), ...(flaggedQuery?.params ?? []), address], limit, offset,
        flaggedQuery?.orderBy ?? stateQuery?.orderBy ?? 'rm.id desc'
    );
};

const getMail = async (c: Context<HonoCustomType>) => {
    const { address } = c.get("jwtPayload")
    const { mail_id } = c.req.param();
    const result = await c.env.DB.prepare(
        `SELECT * FROM raw_mails where id = ? and address = ?`
    ).bind(mail_id, address).first();
    if (!result) return c.json(null);
    return c.json(await serializeMailState(
        c.env.DB,
        await resolveRawEmailRow(result),
        c.env,
    ));
};

const deleteMail = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    if (!getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL)) {
        return c.text(msgs.UserDeleteEmailDisabledMsg, 403)
    }
    const { address } = c.get("jwtPayload")
    const { id } = c.req.param();
    // TODO: add toLowerCase() to handle old data
    const { success } = await deleteRawMails(
        c.env.DB,
        c.env,
        `address = ? and id = ?`,
        [address.toLowerCase(), id],
    );
    return c.json({ success });
};

const updateMailState = async (c: Context<HonoCustomType>) => {
    if (!isMailReadStatusEnabled(c.env)) {
        return c.json({ error: "Mail read status is disabled" }, 403);
    }
    const { address } = c.get("jwtPayload");
    const result = await applyMailStateUpdate(
        c.env.DB,
        { clause: 'rm.address = ?', params: [address] },
        await c.req.json().catch(() => null),
    );
    if (!result) return c.json({ error: "Invalid mail state request" }, 400);
    if (!result.success) return c.json(result, 500);
    return c.json(result);
};

const updateMailFlagged = async (c: Context<HonoCustomType>) => {
    if (!isMailFlaggedEnabled(c.env)) {
        return c.json({ error: "Flagged mail is disabled" }, 403);
    }
    const { address } = c.get("jwtPayload");
    const result = await applyMailFlaggedUpdate(
        c.env.DB,
        { clause: 'rm.address = ?', params: [address] },
        await c.req.json().catch(() => null),
    );
    if (!result) return c.json({ error: "Invalid flagged request" }, 400);
    if (!result.success) return c.json(result, 500);
    return c.json(result);
};

const getMailStates = (c: Context<HonoCustomType>) => {
    if (!isMailReadStatusEnabled(c.env)) {
        return c.json({ error: "Mail read status is disabled" }, 403);
    }
    return c.json({ results: getMailStateOptions() });
};

const getSettings = async (c: Context<HonoCustomType>) => {
    const { address, address_id } = c.get("jwtPayload")
    const msgs = i18n.getMessagesbyContext(c);
    if (address_id && address_id > 0) {
        try {
            const db_address_id = await c.env.DB.prepare(
                `SELECT id FROM address where id = ? `
            ).bind(address_id).first("id");
            if (!db_address_id) {
                return c.text(msgs.InvalidAddressMsg, 400)
            }
        } catch (error) {
            return c.text(msgs.InvalidAddressMsg, 400)
        }
    }
    try {
        if (!address_id) {
            const db_address_id = await c.env.DB.prepare(
                `SELECT id FROM address where name = ? `
            ).bind(address).first("id");
            if (!db_address_id) {
                return c.text(msgs.InvalidAddressMsg, 400)
            }
        }
    } catch (error) {
        return c.text(msgs.InvalidAddressMsg, 400)
    }

    updateAddressUpdatedAt(c, address);

    const { balance } = await getSendBalanceState(c, address);
    return c.json({
        address: address,
        send_balance: balance || 0,
    });
};

const deleteAddress = async (c: Context<HonoCustomType>) => {
    const { address, address_id } = c.get("jwtPayload")
    const success = await deleteAddressWithData(c, address, address_id);
    return c.json({ success });
};

const clearInbox = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    if (!getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL)) {
        return c.text(msgs.UserDeleteEmailDisabledMsg, 403)
    }
    const { address } = c.get("jwtPayload")
    const { success } = await deleteRawMails(
        c.env.DB,
        c.env,
        `address = ?`,
        [address],
    );
    if (!success) {
        return c.text(msgs.FailedClearInboxMsg, 500)
    }
    return c.json({ success });
};

const clearSentItems = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    if (!getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL)) {
        return c.text(msgs.UserDeleteEmailDisabledMsg, 403)
    }
    const { address } = c.get("jwtPayload")
    const { success } = await c.env.DB.prepare(
        `DELETE FROM sendbox WHERE address = ?`
    ).bind(address).run();
    if (!success) {
        return c.text(msgs.FailedClearSentItemsMsg, 500)
    }
    return c.json({ success });
};

export default {
    listMails, getMail, deleteMail, updateMailState, updateMailFlagged, getMailStates,
    getSettings, deleteAddress, clearInbox, clearSentItems
};
