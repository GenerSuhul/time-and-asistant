import crypto from 'node:crypto';
import { extractEventRecords, normalizeAccessEvent } from './normalize-event.js';

export async function fetchAcsEventHistory(client, { devIndex, startTime, endTime, pageSize = 30, onEvent = async () => {} }) {
  if (!devIndex) throw new Error('devIndex es obligatorio');
  if (!startTime || !endTime) throw new Error('startTime y endTime son obligatorios');
  const searchID = crypto.randomUUID();
  let position = 0;
  const normalized = [];

  while (true) {
    const response = await client.searchAcsEvents(devIndex, {
      searchID, searchResultPosition: position, maxResults: pageSize,
      major: 0, minor: 0, startTime, endTime
    });
    const records = extractEventRecords(response);
    for (const record of records) {
      const event = normalizeAccessEvent(record, { devIndex });
      normalized.push(event);
      await onEvent(event);
    }
    const total = Number(response?.AcsEvent?.totalMatches ?? response?.AcsEventSearchResult?.totalMatches ?? NaN);
    position += records.length;
    if (!records.length || records.length < pageSize || (Number.isFinite(total) && position >= total)) break;
  }
  return normalized;
}
