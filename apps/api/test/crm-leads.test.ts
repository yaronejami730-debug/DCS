import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/services/crm/csv.js';
import { leadFromWebhook } from '../src/services/crm/leads.js';

describe('leadFromWebhook', () => {
  it('reads the shape Qhare actually sends', () => {
    const lead = leadFromWebhook({
      id: '123', nom: 'Dupond', prenom: 'Thierry', tel: '0612345678', email: 'd@qhare.fr',
      ville: 'Sarelles', code_postal: '95200', categorie: 'Isolations', etat: 'Lead',
      sous_etat: 'En Attente de document', numdossier: '2023-123456', raison_sociale: 'QHARE',
      nom_societe: 'Demo Energie', event: 'update',
    });
    expect(lead?.externalId).toBe('123');
    expect(lead?.fields.name).toBe('Thierry Dupond');
    expect(lead?.fields.company).toBe('QHARE');
    expect(lead?.fields.phone).toBe('0612345678');
    expect(lead?.fields.reference).toBe('2023-123456');
    expect(lead?.fields.state).toBe('Lead · En Attente de document');
  });
});

describe('parseCsv', () => {
  it('reads a semicolon export with quotes and accents, and maps it like a webhook', () => {
    const csv = '﻿id;Nom;Prénom;Tel;Email;Code postal;Ville;numdossier\n' +
      '42;"Martin; Léa";Léa;06 11 22 33 44;lea@ex.fr;75011;Paris;2024-0007\n' +
      '43;Durand;Paul;;;;;\n';
    const rows = parseCsv(new TextEncoder().encode(csv));
    expect(rows).toHaveLength(2);
    expect(rows[0]!['nom']).toBe('Martin; Léa');
    const lead = leadFromWebhook(rows[0]);
    expect(lead?.externalId).toBe('42');
    expect(lead?.fields.name).toBe('Léa Martin; Léa');
    expect(lead?.fields.postal_code).toBe('75011');
    expect(lead?.fields.reference).toBe('2024-0007');
    expect(leadFromWebhook(rows[1])?.fields.name).toBe('Paul Durand');
  });
});
