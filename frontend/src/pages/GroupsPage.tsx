import { useState } from "react";
import { Badge, Button, Card, CardHeader, Input, MockBanner } from "../components/ui";
import { useT } from "../lib/i18n";

interface GroupItem {
  name: string;
  icon?: string;
}

const INITIAL_GROUPS: GroupItem[] = [
  { name: "YouTube", icon: "https://www.svgrepo.com/show/13671/youtube.svg" },
  { name: "Google", icon: "https://www.svgrepo.com/show/475656/google-color.svg" },
  { name: "Google Play", icon: "https://www.svgrepo.com/show/353828/google-play-icon.svg" },
  { name: "Gemini", icon: "https://www.svgrepo.com/show/331406/gemini.svg" },
  { name: "OpenAI", icon: "https://www.svgrepo.com/show/306500/openai.svg" },
  { name: "Telegram", icon: "https://www.svgrepo.com/show/354443/telegram.svg" },
  { name: "Discord", icon: "https://www.svgrepo.com/show/331368/discord-v2.svg" },
  { name: "Whatsapp" },
  { name: "Instagram", icon: "https://www.svgrepo.com/show/452229/instagram-1.svg" },
  { name: "Facebook", icon: "https://www.svgrepo.com/show/475647/facebook-color.svg" },
  { name: "Twitter", icon: "https://www.svgrepo.com/show/452121/twitter-1.svg" },
  { name: "TikTok", icon: "https://www.svgrepo.com/show/349530/tiktok.svg" },
  { name: "Spotify", icon: "https://www.svgrepo.com/show/349511/spotify.svg" },
  { name: "Netflix", icon: "https://www.svgrepo.com/show/303341/netflix-1-logo.svg" },
  { name: "Twitch", icon: "https://www.svgrepo.com/show/448251/twitch.svg" },
  { name: "Steam", icon: "https://www.svgrepo.com/show/452107/steam.svg" },
  { name: "Microsoft", icon: "https://www.svgrepo.com/show/452062/microsoft.svg" },
  { name: "GitHub", icon: "https://www.svgrepo.com/show/344880/github.svg" },
  { name: "Apple", icon: "https://www.svgrepo.com/show/501448/apple.svg" },
  { name: "Roblox", icon: "https://www.svgrepo.com/show/443377/brand-roblox.svg" },
  { name: "Linkedin", icon: "https://www.svgrepo.com/show/448234/linkedin.svg" },
  { name: "Tidal", icon: "https://www.svgrepo.com/show/504993/tidal.svg" },
  { name: "Viber", icon: "https://www.svgrepo.com/show/125448/viber.svg" },
  { name: "Notion", icon: "https://www.svgrepo.com/show/361558/notion-logo.svg" },
  { name: "Fastly", icon: "https://www.svgrepo.com/show/353730/fastly.svg" },
  { name: "Speedtest", icon: "https://www.svgrepo.com/show/355484/speed.svg" },
  { name: "Oculus" },
  { name: "2IP.IO" },
  { name: "intel" },
  { name: "18+" },
  { name: "other" },
  { name: "RU traffic", icon: "https://www.svgrepo.com/show/508628/flag-ru.svg" },
  { name: "Other traffic" },
  { name: "Блокировка рекламы", icon: "https://www.svgrepo.com/show/300290/sign-roadblock.svg" },
];

function GroupIcon({ name, icon }: { name: string; icon?: string }) {
  if (icon) {
    return (
      <img src={icon} alt="" className="h-5 w-5 shrink-0 rounded object-contain" loading="lazy"
        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
    );
  }
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-zk-surface-hover text-[10px] font-bold text-zk-muted">
      {name[0]?.toUpperCase()}
    </span>
  );
}

export function GroupsPage() {
  const t = useT();
  const [groups, setGroups] = useState<GroupItem[]>(INITIAL_GROUPS);
  const [newName, setNewName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const addGroup = () => {
    const trimmed = newName.trim();
    if (!trimmed || groups.some((g) => g.name === trimmed)) return;
    setGroups((prev) => [...prev, { name: trimmed }]);
    setNewName("");
  };

  const deleteGroup = (name: string) => {
    setGroups((prev) => prev.filter((g) => g.name !== name));
    setConfirmDelete(null);
  };

  return (
    <div className="page-enter space-y-4">
      <MockBanner />

      <div>
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{t("groups.title")}</h1>
        <p className="mt-1 text-sm text-zk-muted">{t("groups.subtitle")}</p>
      </div>

      {/* Add new group */}
      <Card>
        <CardHeader title={t("groups.newGroup")} subtitle={t("groups.newGroupSub")} />
        <div className="flex items-end gap-3 p-4 sm:p-5">
          <div className="flex-1">
            <Input
              label={t("groups.name")}
              placeholder={t("groups.namePlaceholder")}
              value={newName}
              onChange={setNewName}
              hint={t("groups.nameHint")}
            />
          </div>
          <Button
            size="md"
            variant="primary"
            onClick={addGroup}
            disabled={!newName.trim() || groups.some((g) => g.name === newName.trim())}
          >
            {t("groups.add")}
          </Button>
        </div>
      </Card>

      {/* Existing groups */}
      <Card className="overflow-hidden">
        <CardHeader
          title={t("groups.existingTitle")}
          subtitle={t("groups.existingCount", { count: groups.length })}
        />
        <div className="divide-y divide-zk-border-soft">
          {groups.map((g) => (
            <div key={g.name} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
              <GroupIcon name={g.name} icon={g.icon} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{g.name}</span>
              <Badge variant="muted">select</Badge>
              {confirmDelete === g.name ? (
                <div className="flex items-center gap-1.5">
                  <Button size="sm" variant="danger" onClick={() => deleteGroup(g.name)}>
                    {t("groups.confirmDelete")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                    ✕
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmDelete(g.name)}
                  className="text-zk-coral/60 hover:text-zk-coral"
                >
                  {t("groups.delete")}
                </Button>
              )}
            </div>
          ))}
        </div>
      </Card>

      {/* Preview */}
      <Card className="overflow-hidden">
        <CardHeader title={t("groups.preview")} subtitle={t("groups.previewSub")} />
        <pre className="scrollbar-thin max-h-[300px] overflow-auto bg-zk-bg/50 p-4 font-mono text-xs leading-relaxed text-zk-muted sm:p-5">
{`proxy-groups:
${groups.map((g) => `  - name: '${g.name}'
    type: select
    use:
      - subscription
    proxies:
      - DIRECT`).join("\n")}`}
        </pre>
      </Card>
    </div>
  );
}
