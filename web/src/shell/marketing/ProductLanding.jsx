// A product's landing in the site's look, drawn from the page its product supplies (`landing.page` in the
// registry, read in plain Node by scripts/build-landing-shells.mjs for the first HTML): the first screen, the
// sections with their pictures and features, two text sections sharing a row, where it runs, the questions and
// the closing. The page says nothing the product did not write, so the first HTML and this page say the same.
// Every link and control tells one event under the product's id.

import React, { useEffect } from 'react';
import { Icon } from '../../design-system';
import { useAppearance } from '../useAppearance.js';
import { track } from '../../telemetry/beacon.js';
import { ArrowLink, PictureFrame, SiteFooter, SiteFrame, SiteHeader, followed } from './SiteChrome.jsx';
import './productLanding.css';

// A heading's break is a newline in the product's words; the first HTML draws the same <br>.
const lines = (text) => text.split('\n').map((line, index) => (index ? <React.Fragment key={index}><br />{line}</React.Fragment> : line));

function Features({ section, onFollow }) {
  return (
    <ul className="front-features">
      {section.features.map((feature) => (
        <li key={feature.title}>
          <h3 className="front-feature-title">{feature.title}</h3>
          <p className="front-text">{feature.text}</p>
          {feature.link && <ArrowLink className="product-feature-link" href={feature.link.href} onFollow={onFollow('feature', feature.link)}>{feature.link.label}</ArrowLink>}
        </li>
      ))}
    </ul>
  );
}

// What follows a section's features: a line in the third ink, then the section's own link.
function Tail({ section, onFollow }) {
  return (
    <>
      {section.line && <p className="product-line">{section.line}</p>}
      {section.link && <ArrowLink className="product-section-link" href={section.link.href} onFollow={onFollow('section', section.link)}>{section.link.label}</ArrowLink>}
    </>
  );
}

function Section({ product, section, theme, onFollow }) {
  return (
    <section id={section.id} className="front-room product-section" aria-labelledby={`${product.id}-${section.key}`}>
      <div className="front-wrap front-rule">
        <div className="front-room-head">
          <h2 className="front-title" id={`${product.id}-${section.key}`}>{lines(section.title)}</h2>
          <p className="front-text">{section.paragraph}</p>
        </div>
        {section.picture && <PictureFrame id={product.id} picture={section.picture} theme={theme} page={product.id} route={product.landing.href} />}
        <Features section={section} onFollow={onFollow} />
        <Tail section={section} onFollow={onFollow} />
      </div>
    </section>
  );
}

// At desktop width two text sections share one row, each a column of its own; on a phone they stand one after the other.
function Pair({ product, pair, onFollow }) {
  return (
    <div className="product-pair">
      <div className="front-wrap front-rule product-pair-row">
        {pair.map((section) => (
          <section key={section.key} id={section.id} className="product-pair-column" aria-labelledby={`${product.id}-${section.key}`}>
            <h2 className="front-title" id={`${product.id}-${section.key}`}>{lines(section.title)}</h2>
            <p className="front-text">{section.paragraph}</p>
            <Features section={section} onFollow={onFollow} />
            <Tail section={section} onFollow={onFollow} />
          </section>
        ))}
      </div>
    </div>
  );
}

// The first screen's two links and the closing's one, in the feature title's size with a 16px arrow.
function LeadLink({ link, onFollow, area }) {
  return (
    <a className="product-lead-link" href={link.href} onClick={onFollow(area, link)}>
      {link.label}
      <Icon name="arrow-right" size={16} strokeWidth={2.2} />
    </a>
  );
}

export function ProductLanding({ product, page }) {
  const { resolved: theme } = useAppearance();
  const night = theme === 'dark';
  const { first, sections, runs, questions, closing } = page;
  const onFollow = (area, link) => followed(product.id, area, link.to, link.product);

  useEffect(() => { track('front_open', { page: product.id }); }, [product.id]);

  return (
    <SiteFrame path={product.landing.href} header={<SiteHeader page={product.id} night={night} />} footer={<SiteFooter page={product.id} night={night} />}>
      <section className="product-first">
        <div className="front-wrap">
          <h1 className="product-heading" data-breaks={first.headingBreaks}>{lines(first.heading)}</h1>
          <p className="product-what">{first.line}</p>
          <div className="product-leads">
            {first.links.map((link) => <LeadLink key={link.href} link={link} area="first" onFollow={onFollow} />)}
          </div>
          <p className="product-trust">{first.trust}</p>
          <PictureFrame id={product.id} picture={first.picture} theme={theme} page={product.id} route={product.landing.href} className="product-hero" />
        </div>
      </section>

      {sections.map((section) => (section.pair
        ? <Pair key={section.pair[0].key} product={product} pair={section.pair} onFollow={onFollow} />
        : <Section key={section.key} product={product} section={section} theme={theme} onFollow={onFollow} />))}

      {runs && (
        <section className="product-runs">
          <p className="front-wrap front-rule">{runs}</p>
        </section>
      )}

      <section className="product-questions" aria-labelledby={`${product.id}-questions`}>
        <div className="front-wrap front-rule product-questions-row">
          <h2 className="front-title" id={`${product.id}-questions`}>{page.questionsTitle}</h2>
          <dl>
            {questions.map((entry) => (
              <div key={entry.question} className="product-question">
                <dt>{entry.question}</dt>
                <dd>{entry.answer}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="product-closing">
        <div className="front-wrap front-rule">
          <h2 className="product-closing-line">{closing.line}</h2>
          <LeadLink link={closing.link} area="closing" onFollow={onFollow} />
        </div>
      </section>
    </SiteFrame>
  );
}
