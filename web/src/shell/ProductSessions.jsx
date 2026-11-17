import React, { createContext, useContext } from 'react';

const SessionContributions = createContext([]);

export function ProductSessions({ products, dataScope, children }) {
  const contributions = products.flatMap((product) => product.session ? [product.session] : []);
  const content = contributions.reduceRight((nested, { Provider }, index) => (
    <Provider key={index} dataScope={dataScope}>{nested}</Provider>
  ), children);
  return <SessionContributions.Provider value={contributions}>{content}</SessionContributions.Provider>;
}

export function ProductSessionNotices() {
  return useContext(SessionContributions).map(({ Notice }, index) => Notice ? <Notice key={index} /> : null);
}
