import { Link } from 'react-router-dom';
import { useDeleteTemplate, useTemplates } from '../lib/queries';
import { Page } from '../components/Layout';
import { Button, Card, EmptyState, Spinner, formatDate } from '../components/ui';

export const TemplatesPage = () => {
  const { data, isLoading } = useTemplates();
  const remove = useDeleteTemplate();

  return (
    <Page
      title="Templates"
      description="Un template décrit où placer la signature et le tampon dans un document donné."
    >
      {isLoading ? (
        <Spinner />
      ) : (data?.items.length ?? 0) === 0 ? (
        <Card>
          <EmptyState
            title="Aucun template"
            description="Ouvrez un dossier, importez un PDF puis cliquez sur « Configurer » pour placer les zones de signature."
            action={
              <Link to="/folders">
                <Button>Aller aux dossiers</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-ink-200/70">
            {data!.items.map((template) => {
              const signatures = template.zones?.filter((z) => z.type === 'signature').length ?? 0;
              const stamps = template.zones?.filter((z) => z.type === 'stamp').length ?? 0;
              return (
                <li key={template.id} className="flex items-center justify-between gap-4 px-5 py-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{template.name}</p>
                    <p className="mt-0.5 text-xs text-ink-400">
                      {signatures} signature(s) · {stamps} tampon(s)
                      {template.pageCount ? ` · ${template.pageCount} page(s)` : ''}
                      {template.documentHash ? ' · reconnu par empreinte' : ' · sans empreinte'} ·
                      modifié le {formatDate(template.updatedAt)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Link to={`/templates/${template.id}`}>
                      <Button variant="secondary">Ouvrir</Button>
                    </Link>
                    <Button
                      variant="danger"
                      onClick={() => {
                        if (window.confirm(`Supprimer le template « ${template.name} » ?`)) {
                          remove.mutate(template.id);
                        }
                      }}
                    >
                      Supprimer
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </Page>
  );
};
