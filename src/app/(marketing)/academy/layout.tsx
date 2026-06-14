import { sectionsWithContent, articlesInSection } from "@/content/academy/registry";
import { SECTION_GROUPS } from "@/content/academy/sections";
import { AcademySidebar, type SidebarSection } from "./_sidebar";

export default function AcademyLayout({ children }: { children: React.ReactNode }) {
  const sections = sectionsWithContent();
  const sidebarSections: SidebarSection[] = sections.map((s) => ({
    id: s.id,
    title: s.title,
    group: s.group,
    articles: articlesInSection(s.id).map((a) => ({ slug: a.slug, title: a.title })),
  }));
  const groups = SECTION_GROUPS.map((group) => ({
    group,
    sections: sidebarSections.filter((s) => s.group === group),
  })).filter((g) => g.sections.length > 0);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="grid grid-cols-1 lg:grid-cols-[16rem_minmax(0,1fr)] gap-8">
        <aside className="hidden lg:block">
          <div className="sticky top-6 max-h-[calc(100vh-3rem)] overflow-y-auto pr-2">
            <AcademySidebar groups={groups} />
          </div>
        </aside>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
