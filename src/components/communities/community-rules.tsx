import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** PRD.md §4.6 "Rules". */
export function CommunityRules({ rules }: { rules: string[] }) {
  if (rules.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rules</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-3">
          {rules.map((rule, index) => (
            <li key={index} className="flex gap-3 text-sm">
              <span className="text-primary font-display shrink-0 font-semibold">
                {index + 1}.
              </span>
              <span>{rule}</span>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
