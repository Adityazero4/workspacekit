export function repositoryRoot(): string;
export function collectTemplateFiles(exampleDirectory: string): Promise<string[]>;
export function buildTemplates(root: string, outputDirectory: string): Promise<void>;
