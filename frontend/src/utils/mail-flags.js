export const MAIL_FLAGS = {
  UNREAD: 1,
}

export const hasMailFlag = (flags, flag) => {
  return (Number(flags ?? 0) & flag) !== 0
}

export const getMailFlagFilterQuery = (filter) => {
  if (filter === 'unread') return '&flag=0&flag_state=set'
  if (filter === 'read') return '&flag=0&flag_state=unset'
  return ''
}
