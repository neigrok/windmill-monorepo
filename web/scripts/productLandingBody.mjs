// A product landing's first HTML, from the same page its running landing draws (the product's landing.page): every
// heading, paragraph, feature, link, question and answer, in the order and the elements shell/marketing/ProductLanding.jsx
// gives them, without the pictures. The build writes it into each shell, and a browser test holds the two alike.

// Catalog text is escaped for where it lands; an & that cannot open a character reference stays itself, and a no-break
// space is written as its reference so the source shows it.
export const htmlText = (value) => String(value).replace(/&(?=[#A-Za-z0-9])/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
export const htmlAttribute = (value) => htmlText(value).replace(/"/g, '&quot;');

const lines = (text) => String(text).split('\n').map(htmlText).join('<br>');
const link = ({ href, label, note }) => `<a href="${htmlAttribute(href)}">${htmlText(label)}${note ? ` <span>${htmlText(note)}</span>` : ''}</a>`;

function section(part) {
  const features = part.features.map((feature) => `<li><h3>${htmlText(feature.title)}</h3><p>${htmlText(feature.text)}</p>${feature.link ? link(feature.link) : ''}</li>`);
  return [
    `<section${part.id ? ` id="${htmlAttribute(part.id)}"` : ''}>`,
    `<h2>${lines(part.title)}</h2>`,
    `<p>${htmlText(part.paragraph)}</p>`,
    `<ul>${features.join('')}</ul>`,
    part.line ? `<p>${htmlText(part.line)}</p>` : '',
    part.link ? link(part.link) : '',
    '</section>',
  ].join('');
}

// The page's <main>: the whole page in its own words, with nothing it does not say.
export function productLandingMain(page) {
  const missing = ['first', 'sections', 'questionsTitle', 'questions', 'closing'].filter((field) => !page?.[field]);
  if (missing.length) throw new Error(`productLandingBody: the page is missing its ${missing.join(', ')}`);
  const { first, sections, runs, questions, closing } = page;
  return [
    '<main style="max-width: 720px; margin: 0 auto; padding: 72px 24px; font-family: system-ui, -apple-system, \'Segoe UI\', sans-serif; line-height: 1.5; color: #211B13;">',
    `<h1>${lines(first.heading)}</h1>`,
    `<p>${htmlText(first.line)}</p>`,
    `<div>${first.links.map(link).join(' ')}</div>`,
    `<p>${htmlText(first.trust)}</p>`,
    ...sections.flatMap((entry) => (entry.pair ?? [entry]).map(section)),
    runs ? `<p>${htmlText(runs)}</p>` : '',
    `<section><h2>${htmlText(page.questionsTitle)}</h2><dl>${questions.map((entry) => `<div><dt>${htmlText(entry.question)}</dt><dd>${htmlText(entry.answer)}</dd></div>`).join('')}</dl></section>`,
    `<section><h2>${htmlText(closing.line)}</h2>${link(closing.link)}</section>`,
    '</main>',
  ].join('\n');
}

// The questions as search reads them: the list the page draws, entry for entry.
export function questionsSchema(page, url) {
  return {
    '@type': 'FAQPage',
    '@id': `${url}#questions`,
    'url': url,
    'mainEntity': page.questions.map((entry) => ({
      '@type': 'Question',
      'name': entry.question,
      'acceptedAnswer': { '@type': 'Answer', 'text': entry.answer },
    })),
  };
}
