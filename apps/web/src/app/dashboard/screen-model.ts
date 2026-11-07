import { type BrandName } from '../shell/brands';
import { type IconName } from '../shell/icons';

/**
 * The building blocks of a dashboard screen, after the design's screen renderer. A screen is a
 * header (title, pills, actions) and either a list of blocks or sections of blocks, shown as a side
 * menu or as tabs. Text is English source text; the renderer translates it.
 */
export type View = string;

export interface Cell {
  readonly t: string;
  readonly mono?: boolean;
  readonly dim?: boolean;
  readonly fg?: string;
  readonly dot?: string;
  readonly logo?: BrandName;
  readonly icon?: IconName;
}
export type CellInput = string | Cell;

export interface Row {
  readonly cells: readonly CellInput[];
  readonly go?: View;
}

export type Stat = readonly [
  icon: IconName,
  label: string,
  value: string,
  sub?: string,
  color?: string,
];

export interface FieldItem {
  readonly l: string;
  readonly v?: string;
  readonly h?: string;
  readonly mono?: boolean;
  readonly tag?: string;
  readonly toggle?: boolean;
}

export interface CardItem {
  readonly name: string;
  readonly sub?: string;
  readonly desc?: string;
  readonly icon?: IconName;
  readonly logo?: BrandName;
  readonly badge?: string;
  readonly bc?: string;
  readonly meta?: readonly (readonly [IconName, string])[];
  readonly cta?: string;
  readonly go?: View;
  readonly hl?: number;
}

export interface CodeLine {
  readonly t: string;
  readonly p?: string;
  readonly c?: string;
}

export interface Step {
  readonly t: string;
  readonly d: string;
  readonly icon: IconName;
  readonly state?: 'done' | 'active';
  readonly cta?: string;
  readonly go?: View;
}

interface BlockBase {
  readonly title?: string;
  readonly aside?: string;
}
export type Block = BlockBase &
  (
    | { readonly type: 'stats'; readonly items: readonly Stat[] }
    | { readonly type: 'fields'; readonly items: readonly FieldItem[] }
    | {
        readonly type: 'table';
        readonly cols: string;
        readonly heads: readonly string[];
        readonly rows: readonly (Row | readonly CellInput[])[];
        readonly add?: string;
      }
    | { readonly type: 'cards'; readonly min?: string; readonly items: readonly CardItem[] }
    | {
        readonly type: 'code';
        readonly mh?: string;
        readonly lines: readonly (string | CodeLine)[];
      }
    | { readonly type: 'steps'; readonly items: readonly Step[] }
    | { readonly type: 'danger'; readonly items: readonly (readonly [string, string, string])[] }
    | { readonly type: 'note'; readonly text: string; readonly tone?: 'warn' | 'ours' }
  );

export interface Section {
  readonly k: string;
  readonly label: string;
  readonly icon?: IconName;
  readonly head?: string;
  readonly ours?: number;
  readonly title?: string;
  readonly desc?: string;
  readonly blocks: readonly Block[];
}

export type Action = readonly [label: string, icon: IconName, primary: number, go?: View];

export interface Screen {
  readonly label: string;
  readonly title: string;
  readonly sub?: string;
  readonly crumbs: readonly string[];
  readonly logo?: BrandName;
  readonly pills?: readonly (readonly [string, string?])[];
  readonly actions?: readonly Action[];
  readonly layout?: 'tabs';
  readonly sections?: readonly Section[];
  readonly blocks?: readonly Block[];
}
