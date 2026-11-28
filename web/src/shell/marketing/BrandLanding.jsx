// The brand front door at the bare root, in the instrument look: what Windmill is, its three tools, a
// section per open product composed off the registry's `landing.root`, the two ways to bring an AI and
// where it runs, in the site's header and footer. A product still holding itself shut brings no row and
// no section but keeps its place in the header and the footer. Every link and control tells one event
// under the page `front`, and a picture tells one when the pointer stays on it.

import React, { useEffect } from 'react';
import { PRODUCTS } from '../products.js';
import { useAppearance } from '../useAppearance.js';
import { track } from '../../telemetry/beacon.js';
import { ArrowLink, PictureFrame, SiteFooter, SiteFrame, SiteHeader, followed } from './SiteChrome.jsx';
import { t } from '../i18n/entry/index.js';
import './brandLanding.css';

export function BrandLanding() {
  const { resolved: theme } = useAppearance();
  const night = theme === 'dark';
  const open = PRODUCTS.filter((product) => product.shell.status === 'open');

  useEffect(() => { track('front_open', { page: 'front' }); }, []);

  return (
    <SiteFrame path="/" header={<SiteHeader page="front" night={night} />} footer={<SiteFooter page="front" night={night} />}>
      <section className="front-first">
        <div className="front-wrap">
          <h1 className="front-heading">{t('shell.landingHead.heading', { break: <br /> })}</h1>
          <p className="front-what">{t('shell.landingHead.what')}</p>
          <p className="front-stance">{t('shell.landingHead.stance')}</p>
        </div>
      </section>

      <section aria-label={t('shell.brandLanding.tools')}>
        <ul className="front-wrap front-tools-row front-rule">
          {open.map(({ id, label, landing: { root } }) => (
            <li key={id} className="front-tool">
              <h2 className="front-tool-name">{t('shell.brandLanding.toolName', { product: label })}</h2>
              <p className="front-tool-kind">{root.kind}</p>
              <p className="front-tool-line">{root.line}</p>
              <ArrowLink href={root.link.href} onFollow={followed('front', 'tools', root.link.to, id)}>{root.link.label}</ArrowLink>
            </li>
          ))}
        </ul>
      </section>

      {open.map(({ id, landing: { root: { title, paragraph, link, features, picture } } }) => (
        <section key={id} className="front-room" aria-labelledby={`front-${id}`}>
          <div className="front-wrap front-rule">
            <div className="front-room-head">
              <h2 className="front-title" id={`front-${id}`}>{title}</h2>
              <div>
                <p className="front-text">{paragraph}</p>
                <ArrowLink href={link.href} onFollow={followed('front', 'room', link.to, id)}>{link.label}</ArrowLink>
              </div>
            </div>
            <PictureFrame id={id} picture={picture} theme={theme} page="front" route="/" />
            <ul className="front-features">
              {features.map((feature) => (
                <li key={feature.title}>
                  <h3 className="front-feature-title">{feature.title}</h3>
                  <p className="front-text">{feature.text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ))}

      <section aria-labelledby="front-ai">
        <div className="front-wrap front-ai-row front-rule">
          <div>
            <h2 className="front-title" id="front-ai">{t('shell.brandLanding.aiTitle', { break: <br /> })}</h2>
            <p className="front-text">{t('shell.brandLanding.aiLine')}</p>
          </div>
          <div className="front-ai-way">
            <h3 className="front-ai-name">{t('shell.brandLanding.yoursTitle')}</h3>
            <p className="front-text">{t('shell.brandLanding.yoursText')}</p>
            <ArrowLink href="/connect.html" onFollow={followed('front', 'ai', 'connect')}>{t('shell.brandLanding.yoursLink')}</ArrowLink>
          </div>
          <div className="front-ai-way">
            <h3 className="front-ai-name">{t('shell.brandLanding.oursTitle')}</h3>
            <p className="front-text">{t('shell.brandLanding.oursText')}</p>
            <ArrowLink href="/pricing.html" onFollow={followed('front', 'ai', 'pricing')}>{t('shell.brandLanding.oursLink')}</ArrowLink>
          </div>
        </div>
      </section>

      <section className="front-runs">
        <p className="front-wrap front-rule">{t('shell.brandLanding.runs')}</p>
      </section>
    </SiteFrame>
  );
}
