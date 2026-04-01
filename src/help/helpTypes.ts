export type HelpPageRecord = {
  path: string;
  url: string;
  title: string;
  text: string;
};

export type HelpCorpus = {
  crawledAt: string;
  baseUrl: string;
  pages: HelpPageRecord[];
};
