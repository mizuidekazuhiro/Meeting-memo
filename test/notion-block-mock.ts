// @ts-nocheck
// Keep the fake Notion append/read contract faithful for staged memo writes.
export function withNotionBlockStorage(delegate: typeof fetch): typeof fetch {
  const blocks = new Map<string, any[]>();
  let serial = 0;
  return (async (input, init) => {
    const url = String(input);
    const match = url.match(/\/blocks\/([^/?]+)\/children/);
    if (match && init?.method === 'PATCH') {
      const response = await delegate(input, init);
      if (!response.ok) return response;
      const created = JSON.parse(String(init.body)).children.map((block) => ({
        ...block, id: `staged-${++serial}`,
      }));
      blocks.set(match[1], [...(blocks.get(match[1]) ?? []), ...created]);
      return Response.json({ results: created });
    }
    if (match && match[1].startsWith('staged-') && (init?.method ?? 'GET') === 'GET') {
      return Response.json({ results: blocks.get(match[1]) ?? [], has_more: false, next_cursor: null });
    }
    return delegate(input, init);
  }) as any;
}
