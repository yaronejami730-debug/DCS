import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { ClientsPage } from './pages/Clients';
import { FoldersPage } from './pages/Folders';
import { FolderDetailPage } from './pages/FolderDetail';
import { TemplatesPage } from './pages/Templates';
import { TemplateEditorPage } from './pages/TemplateEditor';
import { DocumentPlacementPage } from './pages/DocumentPlacement';
import { FolderComparisonPage } from './pages/FolderComparison';
import { CropReturnPage } from './pages/CropReturn';
import { AttestationPage } from './pages/Attestation';
import { GuidePage } from './pages/Guide';

export const App = () => {
  const { session } = useAuth();

  if (!session) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/dashboard" replace />} />
      <Route element={<Layout />}>
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/folders" element={<FoldersPage />} />
        <Route path="/clients" element={<ClientsPage />} />
        <Route path="/folders/:id" element={<FolderDetailPage />} />
        <Route path="/folders/:id/comparer" element={<FolderComparisonPage />} />
        {/* Crop the marks out of a page a technician sent back. */}
        <Route path="/folders/:id/reception/:returnId" element={<CropReturnPage />} />
        <Route path="/attestation" element={<AttestationPage />} />
        <Route path="/guide" element={<GuidePage />} />
        <Route path="/templates" element={<TemplatesPage />} />
        <Route path="/templates/:id" element={<TemplateEditorPage />} />
        <Route path="/documents/:id/placement" element={<DocumentPlacementPage />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  );
};
