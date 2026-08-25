import { Context } from 'hono'

import i18n from '../i18n';
import { getBooleanValue } from '../utils';
import { handleMailListQuery, deleteAddressWithData, updateAddressUpdatedAt } from '../common'
import { resolveRawEmailRow } from '../gzip'
import { getSendBalanceState } from './send_balance';
import {
    getMailStateQuery,
    getMailStateOptions,
    applyMailStateUpdate,
    serializeMailState,
} from '../mail_flags';

const listMails = async (c: Context<HonoCustomType>) => {
    const { address } = c.get("jwtPayload")
    if (!address) {
        return c.json({ "error": "No address" }, 400)
    }
    const { limit, offset, mail_state } = c.req.query();
    if (Number.parseInt(offset) <= 0) updateAddressUpdatedAt(c, address);
    const stateQuery = getMailStateQuery(mail_state, 'flags');
    if (stateQuery === null) return c.json({ error: "Invalid mail state filter" }, 400);
    if (stateQuery && !getBooleanValue(c.env.ENABLE_MAIL_FLAGS)) {
        return c.json({ error: "Mail states are disabled" }, 403);
    }

    const filters = [`address = ?`];
    const params = [address];
    if (stateQuery) {
        filters.push(stateQuery.clause);
        params.push(...stateQuery.params);
    }
    const whereClause = filters.join(' AND ');
    return await handleMailListQuery(c,
        `SELECT * FROM raw_mails WHERE ${whereClause}`,
        `SELECT count(*) as count FROM raw_mails WHERE ${whereClause}`,
        params, limit, offset
    );
};

const getMail = async (c: Context<HonoCustomType>) => {
    const { address } = c.get("jwtPayload")
    const { mail_id } = c.req.param();
    const result = await c.env.DB.prepare(
        `SELECT * FROM raw_mails where id = ? and address = ?`
    ).bind(mail_id, address).first();
    if (!result) return c.json(null);
    return c.json(serializeMailState(
        await resolveRawEmailRow(result),
        getBooleanValue(c.env.ENABLE_MAIL_FLAGS),
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
    const { success } = await c.env.DB.prepare(
        `DELETE FROM raw_mails WHERE address = ? and id = ? `
    ).bind(address.toLowerCase(), id).run();
    return c.json({ success });
};

const updateMailState = async (c: Context<HonoCustomType>) => {
    if (!getBooleanValue(c.env.ENABLE_MAIL_FLAGS)) {
        return c.json({ error: "Mail states are disabled" }, 403);
    }
    const { address } = c.get("jwtPayload");
    const result = await applyMailStateUpdate(
        c.env.DB,
        { clause: 'address = ?', params: [address] },
        await c.req.json().catch(() => null),
    );
    if (!result) return c.json({ error: "Invalid mail state request" }, 400);
    if (!result.success) return c.json(result, 500);
    return c.json(result);
};

const getMailStates = (c: Context<HonoCustomType>) => {
    if (!getBooleanValue(c.env.ENABLE_MAIL_FLAGS)) {
        return c.json({ error: "Mail states are disabled" }, 403);
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
    const { success } = await c.env.DB.prepare(
        `DELETE FROM raw_mails WHERE address = ?`
    ).bind(address).run();
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
    listMails, getMail, deleteMail, updateMailState, getMailStates,
    getSettings, deleteAddress, clearInbox, clearSentItems
};
