import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../components/Layout';
import { Card } from '../components/ui';

/**
 * The manual, in the app.
 *
 * One place that answers "which button, in what order" for the whole flow —
 * folders, import roles, share links, the signer's side, returns, cropping,
 * type recognition, the attestation. Written for an operator who has never
 * seen the console, in plain steps, so onboarding does not depend on someone
 * being shown it in person.
 */

interface QA {
  q: string;
  a: React.ReactNode;
}

interface Section {
  title: string;
  intro?: string;
  items: QA[];
}

const SECTIONS: Section[] = [
  {
    title: '1 · Vue d’ensemble',
    intro: 'Le principe en une phrase.',
    items: [
      {
        q: 'À quoi sert Scan&Sign ?',
        a: (
          <>
            Vous préparez des documents à faire signer, vous envoyez un lien au signataire
            (technicien, client…), il imprime, signe à la main, photographie et vous renvoie la
            page. Vous recadrez chaque signature dans la console, et le système l’appose sur vos
            documents aux emplacements que vous avez définis.
          </>
        ),
      },
      {
        q: 'Les grandes étapes ?',
        a: (
          <ol className="ml-4 list-decimal space-y-1">
            <li>Créer un dossier.</li>
            <li>Importer les PDF (document à faire signer ou feuille de signature).</li>
            <li>Configurer les zones de signature sur le document (template).</li>
            <li>Créer un lien de signature et l’envoyer.</li>
            <li>Le signataire imprime, signe, renvoie la page.</li>
            <li>Vous capturez les signatures et le système les appose.</li>
          </ol>
        ),
      },
    ],
  },
  {
    title: '2 · Créer un dossier',
    items: [
      {
        q: 'Comment créer un dossier ?',
        a: (
          <>
            Onglet <b>Dossiers</b> → bouton <b>Nouveau dossier</b> → donnez-lui un nom (ex. « Client
            Renault »). Un dossier regroupe les documents signés ensemble par un même lien.
          </>
        ),
      },
      {
        q: 'Comment ouvrir un dossier existant ?',
        a: <>Onglet <b>Dossiers</b>, cliquez sur la ligne du dossier.</>,
      },
    ],
  },
  {
    title: '3 · Importer des PDF',
    intro: 'Chaque PDF joue un rôle. La question vous est posée à chaque import.',
    items: [
      {
        q: 'Comment importer un PDF ?',
        a: (
          <>
            Dans le dossier → bouton <b>Importer des PDF</b> → <b>Choisir des fichiers</b> → une
            fenêtre demande <b>ce qu’est ce PDF</b> :
            <ul className="ml-4 mt-1 list-disc space-y-1">
              <li>
                <b>Un lien de signature</b> — la feuille que le technicien imprime et signe. Part
                avec le lien.
              </li>
              <li>
                <b>Un document à faire signer</b> — le contrat qui recevra la signature. Vous y
                placez les zones.
              </li>
            </ul>
          </>
        ),
      },
      {
        q: 'Je me suis trompé de rôle, c’est grave ?',
        a: (
          <>
            Une feuille classée « à faire signer » attend juste un template (visible, un clic à
            corriger). Un contrat classé « feuille » ne sera pas tamponné — reprenez l’import avec
            le bon rôle.
          </>
        ),
      },
      {
        q: 'Puis-je importer l’attestation simplifiée ?',
        a: (
          <>
            Oui. Dans l’onglet <b>Attestation simplifiée</b>, bouton <b>Se servir de ce modèle</b>,
            puis dans le dossier → <b>Importer un PDF</b> → <b>Utiliser l’attestation simplifiée</b>.
          </>
        ),
      },
    ],
  },
  {
    title: '4 · Configurer les zones (template)',
    items: [
      {
        q: 'Comment dire où placer la signature ?',
        a: (
          <>
            Sur un document à faire signer, ouvrez son éditeur de zones (onglet <b>Templates</b> ou
            depuis le document). Tracez un rectangle pour chaque zone et choisissez son type :
            signature, tampon, tampon + signature, lu et approuvé, date, date de devis, texte,
            case.
          </>
        ),
      },
      {
        q: 'Pourquoi le type de zone est important ?',
        a: (
          <>
            Le système fonctionne <b>par type</b> : une signature capturée n’atterrit que dans une
            zone de type « signature », une date dans une zone « date », etc. Sans zone du bon type,
            la marque n’a nulle part où aller.
          </>
        ),
      },
    ],
  },
  {
    title: '5 · Le lien de signature',
    items: [
      {
        q: 'Comment créer et envoyer un lien ?',
        a: (
          <>
            Dans le dossier, section <b>Liens de signature</b> → <b>Créer un lien</b>. Choisissez
            pour qui, l’expiration, les feuilles concernées, et la demande de position. Puis
            <b> Copier</b> le lien et envoyez-le par SMS, e-mail, WhatsApp.
          </>
        ),
      },
      {
        q: 'Le signataire doit-il un compte ?',
        a: (
          <>
            Non. Le lien seul suffit — il ouvre la page dans n’importe quel navigateur, sans
            compte ni installation. Le lien est impossible à deviner, révocable et expirable.
          </>
        ),
      },
      {
        q: 'Puis-je couper un lien ?',
        a: <>Oui, bouton <b>Révoquer</b> sur la ligne du lien. Il cesse aussitôt de fonctionner.</>,
      },
      {
        q: 'Je veux voir si la personne est en train de l’utiliser ?',
        a: (
          <>
            Un point vert animé apparaît sur le lien avec l’étape en cours (consulte, imprime,
            envoie…). Gris avec « vu le… » quand la personne n’est plus active.
          </>
        ),
      },
      {
        q: 'Signer depuis mon propre téléphone ?',
        a: (
          <>
            Bouton <b>Signer sur mon téléphone</b> : un QR code s’affiche, vous le scannez, et vous
            continuez depuis votre téléphone avec les documents en vue.
          </>
        ),
      },
    ],
  },
  {
    title: '6 · Côté signataire (le technicien)',
    items: [
      {
        q: 'Que voit la personne qui reçoit le lien ?',
        a: (
          <>
            Une page en trois étapes : <b>1)</b> ses documents à ouvrir/imprimer, <b>2)</b> signer à
            la main, <b>3)</b> renvoyer la page photographiée.
          </>
        ),
      },
      {
        q: 'Comment renvoie-t-elle la page signée ?',
        a: (
          <>
            Bouton <b>Photographier la page signée</b> (ouvre l’appareil photo) ou <b>Envoyer un
            fichier/scan</b>. La photo est automatiquement <b>détectée, redressée et recadrée</b>
            avant l’envoi.
          </>
        ),
      },
      {
        q: 'La position est-elle enregistrée ?',
        a: (
          <>
            Si le lien le demande, la date, l’heure et la position sont jointes à l’envoi comme
            preuve de signature sur place. La personne peut refuser : les pages partent quand même.
          </>
        ),
      },
    ],
  },
  {
    title: '7 · Capturer les signatures',
    intro: 'Le document signé revient — vous le recadrez pour l’apposer.',
    items: [
      {
        q: 'Où arrivent les pages renvoyées ?',
        a: (
          <>
            En haut du dossier, encart <b>Documents signés reçus</b> avec un badge « à traiter ».
            Bouton <b>Voir</b> pour l’ouvrir, <b>Capturer les signatures</b> pour recadrer.
          </>
        ),
      },
      {
        q: 'Comment capturer une signature ?',
        a: (
          <ol className="ml-4 list-decimal space-y-1">
            <li>Choisissez d’abord <b>Pour quel document</b> (le contrat destinataire).</li>
            <li>Encadrez la marque sur le scan.</li>
            <li>
              Dites <b>ce qu’elle est</b> (le type se pré-remplit automatiquement si la
              reconnaissance IA est active).
            </li>
            <li><b>Valider cette zone</b>, répétez pour chaque marque.</li>
            <li><b>Détourer et apposer sur ce document</b>.</li>
          </ol>
        ),
      },
      {
        q: 'Plusieurs documents d’un coup ?',
        a: (
          <>
            Oui. Une fois un document servi, il disparaît de la liste « Pour quel document » — il ne
            reste que ceux à traiter. Vous enchaînez sur le même scan.
          </>
        ),
      },
      {
        q: 'Le cadrage réagit mal ?',
        a: (
          <>
            Glissez l’intérieur du cadre pour le déplacer, tirez un coin pour le redimensionner. Sur
            ordinateur, le curseur indique l’action possible.
          </>
        ),
      },
      {
        q: 'La reconnaissance automatique du type ?',
        a: (
          <>
            Si activée, une pastille « ✨ Reconnu : … » apparaît après le cadrage — un clic sur
            <b> Appliquer</b> pré-remplit le type. Vous gardez toujours la main.
          </>
        ),
      },
    ],
  },
  {
    title: '8 · Récupérer les documents signés',
    items: [
      {
        q: 'Où est le PDF final ?',
        a: (
          <>
            Dans le dossier, sur chaque document terminé : <b>Voir le PDF signé</b> (aperçu) et
            <b> Télécharger le PDF signé</b>.
          </>
        ),
      },
      {
        q: 'Une signature est mal placée ?',
        a: <>Bouton <b>Modifier la signature</b> sur le document pour la re-positionner.</>,
      },
    ],
  },
  {
    title: '9 · Attestation simplifiée',
    items: [
      {
        q: 'À quoi sert l’onglet Attestation simplifiée ?',
        a: (
          <>
            Générer une attestation d’accord imprimable : une page d’intro (identité du signataire)
            puis une page par document, avec zone de signature/cachet et mention « Lu et approuvé,
            bon pour accord ».
          </>
        ),
      },
      {
        q: 'Comment ça marche ?',
        a: (
          <>
            À gauche l’<b>aperçu en direct</b>, à droite l’éditeur. Renseignez le signataire,
            ajoutez les documents, cochez ce qui apparaît (signature, cachet, ensemble, mention),
            puis <b>Générer le PDF</b>. « Autre document » ouvre une fenêtre pour le nommer.
          </>
        ),
      },
    ],
  },
];

const AccordionItem = ({ item }: { item: QA }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-ink-200/70 last:border-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 py-3 text-left"
      >
        <span className="text-ink-400">{open ? '−' : '+'}</span>
        <span className="flex-1 text-sm font-medium text-ink-900">{item.q}</span>
      </button>
      {open && <div className="pb-4 pl-7 pr-2 text-sm leading-6 text-ink-600">{item.a}</div>}
    </div>
  );
};

export const GuidePage = () => (
  <Page
    title="Guide"
    description="Comment fonctionne le système, étape par étape — cliquez une question pour la réponse."
  >
    <div className="mb-4 flex flex-wrap gap-2">
      <Link
        to="/folders"
        className="rounded-lg bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 ring-1 ring-brand-200 hover:bg-brand-100"
      >
        Aller aux dossiers →
      </Link>
      <Link
        to="/attestation"
        className="rounded-lg bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 ring-1 ring-brand-200 hover:bg-brand-100"
      >
        Attestation simplifiée →
      </Link>
    </div>

    <div className="space-y-4">
      {SECTIONS.map((section) => (
        <Card key={section.title} className="p-5">
          <h2 className="text-base font-semibold text-ink-900">{section.title}</h2>
          {section.intro && <p className="mt-1 text-sm text-ink-400">{section.intro}</p>}
          <div className="mt-2">
            {section.items.map((item) => (
              <AccordionItem key={item.q} item={item} />
            ))}
          </div>
        </Card>
      ))}
    </div>
  </Page>
);
