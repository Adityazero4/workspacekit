import { Label, Title } from './Type';

const QUESTIONS: readonly { question: string; answer: string }[] = [
  {
    question: 'Who is it for?',
    answer:
      'Teams building agent apps in React, where people need to see, open and manage the files an agent writes: reports, spreadsheets, documents, code.',
  },
  {
    question: 'Do I need Next.js?',
    answer:
      'No. The browser part is a React component, and the handler runs on any server that speaks the Fetch API: Next.js, Remix, Hono or plain Node. There is a Vite guide too.',
  },
  {
    question: 'Where do the files live?',
    answer:
      'In a folder on your server, through nodeFsStore. For anything else, such as S3, write an adapter; the docs have a recipe.',
  },
  {
    question: 'How does my agent connect to it?',
    answer:
      'It does not have to. The agent writes to the folder as it already does, and the workspace sees the change and shows it.',
  },
  {
    question: 'Can people see files they should not?',
    answer:
      'Only if your authorize function says so. It runs for every request, including link targets and each file in a folder download.',
  },
  {
    question: 'What does it cost?',
    answer: 'Nothing. It is open source under the Apache-2.0 licence, with no account and no hosted service.',
  },
];

/**
 * Short answers to the questions people ask before trying it.
 *
 * @example
 * <Faq />
 */
export function Faq(): React.JSX.Element {
  return (
    <section aria-labelledby="faq-heading" className="border-t border-fd-border">
      <div className="mx-auto grid w-full max-w-7xl gap-14 px-5 py-28 sm:px-8 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div className="flex flex-col gap-6">
          <Label>/faq</Label>
          <Title id="faq-heading" lead="Questions people" rest="ask first." />
        </div>
        <div className="border-t border-fd-border">
          {QUESTIONS.map((item) => (
            <details key={item.question} className="group border-b border-fd-border">
              <summary className="flex items-center justify-between gap-6 py-5 text-lg text-fd-foreground [&::-webkit-details-marker]:hidden">
                {item.question}
                <span
                  aria-hidden="true"
                  className="text-fd-muted-foreground transition-transform group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <p className="max-w-[60ch] pb-6 text-[0.95rem] leading-relaxed text-fd-muted-foreground">
                {item.answer}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
