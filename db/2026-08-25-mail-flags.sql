CREATE TABLE IF NOT EXISTS mail_flags (
    mail_id INTEGER NOT NULL,
    address_id INTEGER NOT NULL,
    flag INTEGER NOT NULL,
    PRIMARY KEY (mail_id, flag)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_mail_flags_address_flag_mail ON mail_flags(address_id, flag, mail_id DESC);
