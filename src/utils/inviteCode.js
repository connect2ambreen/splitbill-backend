import { query } from "../config/db.js";
import { v4 as uuidv4 } from 'uuid';

export const generateInviteCode = () => {
    return uuidv4().split('-')[0].toUpperCase();
}

export const generateUniqueInviteCode = async () => {
  let inviteCode, isUnique = false;

  while (!isUnique) {
    inviteCode = generateInviteCode();
    const result = await query('SELECT id FROM groups WHERE invite_code = $1', [inviteCode]);
    isUnique = result.rows.length === 0;
  }

  return inviteCode;
};