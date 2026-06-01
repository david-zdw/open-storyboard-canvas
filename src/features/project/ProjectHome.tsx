import { Suspense, lazy, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderKanban, Library, type LucideIcon } from 'lucide-react';
import { ProjectManager } from './ProjectManager';

type HomeBranch = 'projects' | 'prompts';

const PromptLibrary = lazy(() =>
  import('@/features/promptLibrary/PromptLibrary').then((module) => ({
    default: module.PromptLibrary,
  }))
);

export function ProjectHome() {
  const { t } = useTranslation();
  const [activeBranch, setActiveBranch] = useState<HomeBranch>('projects');

  const branches: Array<{
    id: HomeBranch;
    label: string;
    icon: LucideIcon;
  }> = [
    {
      id: 'projects',
      label: t('mainHome.canvasProjects'),
      icon: FolderKanban,
    },
    {
      id: 'prompts',
      label: t('mainHome.promptLibrary'),
      icon: Library,
    },
  ];

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-bg-dark">
      <div className="shrink-0 border-b border-border-dark bg-bg-dark/95 px-8 py-4">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-lg border border-border-dark bg-surface-dark p-1">
            {branches.map((branch) => {
              const Icon = branch.icon;
              const isActive = activeBranch === branch.id;
              return (
                <button
                  key={branch.id}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => setActiveBranch(branch.id)}
                  className={`inline-flex h-10 items-center gap-2 rounded-md px-4 text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-accent text-white shadow-sm'
                      : 'text-text-muted hover:bg-bg-dark/75 hover:text-text-dark'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {branch.label}
                </button>
              );
            })}
          </div>

          <div className="text-sm text-text-muted">
            {activeBranch === 'projects'
              ? t('mainHome.canvasProjectsHint')
              : t('mainHome.promptLibraryHint')}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeBranch === 'projects' ? (
          <ProjectManager />
        ) : (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center bg-bg-dark text-sm text-text-muted">
                {t('common.loading')}
              </div>
            }
          >
            <PromptLibrary />
          </Suspense>
        )}
      </div>
    </div>
  );
}
