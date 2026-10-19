// Analyse HTML conforme au standard (parse5, même arbre que le navigateur, y compris sur du HTML mal formé)
// et sélecteurs CSS (css-select) : ce qui a été vérifié dans le navigateur reste vrai ici.
import { selectAll, selectOne } from 'css-select';
import type { AnyNode, Document, Element } from 'domhandler';
import { textContent } from 'domutils';
import { parse } from 'parse5';
import { adapter } from 'parse5-htmlparser2-tree-adapter';
import { normaliserTexte } from './normalisation.ts';

export type { Element };
export type Noeud = Document | Element;

export const analyser = (html: string): Document => parse(html, { treeAdapter: adapter });

export const un = (selecteur: string, racine: Noeud): Element | null => selectOne(selecteur, racine);
export const tous = (selecteur: string, racine: Noeud): Element[] => selectAll(selecteur, racine);

/** Texte visible normalisé (espaces réduits). */
export const texte = (n: AnyNode | null): string => (n ? normaliserTexte(textContent(n)) : '');

export const attribut = (el: Element, nom: string): string | undefined => el.attribs[nom];
