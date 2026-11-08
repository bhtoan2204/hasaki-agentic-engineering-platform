import type { SVGProps } from "react";
import type { CompanionState } from "./companionState.ts";

/** Original shared SVG character. The face, proportions, hair and uniform stay identical in every animation state. */
export function HasakiCompanionAvatar({ state, ...props }: SVGProps<SVGSVGElement> & { state: CompanionState }) {
  return <svg viewBox="0 0 160 190" role="img" aria-hidden="true" focusable="false" data-companion-state={state} {...props}>
    <defs>
      <linearGradient id="hc-hair" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#59404a"/><stop offset="1" stopColor="#2e2533"/></linearGradient>
      <linearGradient id="hc-face" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#ffe4d0"/><stop offset="1" stopColor="#f1c4a5"/></linearGradient>
      <linearGradient id="hc-coat" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#cf426b"/><stop offset="1" stopColor="#a92651"/></linearGradient>
    </defs>
    <ellipse cx="80" cy="177" rx="43" ry="7" className="hc-shadow"/>
    <g className="hc-character">
      <g className="hc-body">
        <path d="M56 125 Q44 130 40 157 L47 169 Q58 165 64 158 L67 178 Q80 185 94 178 L96 158 Q102 166 114 169 L121 157 Q116 133 101 125Z" fill="url(#hc-coat)" stroke="#70243c" strokeWidth="3" strokeLinejoin="round"/>
        <path d="M68 125 L80 140 L92 125 L98 131 L88 152 L80 148 L72 152 L62 131Z" fill="#fff6e9" stroke="#8a3a4d" strokeWidth="2" strokeLinejoin="round"/>
        <path d="M74 143 Q80 137 86 143 L83 150 L77 150Z" fill="#dc597b"/>
        <path d="M57 139 Q50 142 48 153 M103 139 Q111 142 112 153" fill="none" stroke="#f2aec0" strokeWidth="4" strokeLinecap="round"/>
        <path d="M69 175 Q65 180 61 181 M91 175 Q95 180 99 181" fill="none" stroke="#4b3540" strokeWidth="7" strokeLinecap="round"/>
        <rect x="94" y="151" width="11" height="11" rx="3" fill="#f7e6c5" stroke="#853044" strokeWidth="2"/><path d="M97 156h5" stroke="#2f6b4f" strokeWidth="2"/>
        <g className="hc-work-prop">
          <path d="M36 153 Q80 145 124 153 L119 171 Q80 178 41 171Z" fill="#304539" stroke="#183d2c" strokeWidth="3"/>
          <path d="M43 155 Q80 150 117 155 L114 166 Q80 171 46 166Z" fill="#d6e8de"/>
          <path d="M74 158l-8 5h12l-3 5 12-7h-10l4-3Z" fill="#2f6b4f"/>
          <path d="M49 172h62l5 6H44Z" fill="#f7e6c5" stroke="#183d2c" strokeWidth="2"/>
        </g>
        <g className="hc-checklist"><rect x="105" y="127" width="30" height="37" rx="4" fill="#fff8e9" stroke="#84684e" strokeWidth="2"/><path d="M111 137l3 3 5-6M111 148l3 3 5-6M122 138h8M122 149h8" fill="none" stroke="#2f6b4f" strokeWidth="2" strokeLinecap="round"/></g>
      </g>
      <g className="hc-head-group">
        <path d="M39 71 Q32 32 59 20 Q87 5 112 24 Q132 39 126 83 L119 111 Q111 125 98 130 L53 122 Q36 105 39 71Z" fill="url(#hc-hair)" stroke="#2c222d" strokeWidth="4" strokeLinejoin="round"/>
        <path d="M47 65 Q43 40 60 30 Q80 17 101 30 Q119 42 115 76 L110 103 Q103 119 82 121 Q60 120 51 103Z" fill="url(#hc-face)" stroke="#8b5d56" strokeWidth="2.5"/>
        <path d="M49 57 Q54 35 72 34 Q87 32 93 43 Q102 29 116 43 L119 61 Q108 54 100 47 Q89 59 72 54 Q61 51 49 65Z" fill="url(#hc-hair)" stroke="#2c222d" strokeWidth="3" strokeLinejoin="round"/>
        <path d="M46 66 Q38 84 50 101 L55 108 Q57 83 52 71Z M115 65 Q126 81 113 101 L108 108 Q106 83 111 71Z" fill="#46313d" stroke="#2c222d" strokeWidth="3"/>
        <path d="M51 63 Q63 57 73 62 M91 62 Q102 57 111 63" fill="none" stroke="#342632" strokeWidth="4" strokeLinecap="round" className="hc-brows"/>
        <g className="hc-eyes">
          <ellipse cx="67" cy="78" rx="9" ry="12" fill="#fffdf9" stroke="#382936" strokeWidth="2"/>
          <ellipse cx="97" cy="78" rx="9" ry="12" fill="#fffdf9" stroke="#382936" strokeWidth="2"/>
          <ellipse cx="69" cy="80" rx="5.7" ry="8" fill="#527a64"/><ellipse cx="95" cy="80" rx="5.7" ry="8" fill="#527a64"/>
          <ellipse cx="70" cy="81" rx="2.8" ry="5" fill="#20212a"/><ellipse cx="96" cy="81" rx="2.8" ry="5" fill="#20212a"/>
          <circle cx="72" cy="76" r="2.6" fill="white"/><circle cx="98" cy="76" r="2.6" fill="white"/>
          <path d="M58 68 Q67 62 76 68 M87 68 Q97 62 106 68" fill="none" stroke="#382936" strokeWidth="3" strokeLinecap="round"/>
        </g>
        <path d="M77 96 Q80 99 83 96" fill="none" stroke="#be806f" strokeWidth="2" strokeLinecap="round"/>
        <path d="M73 106 Q80 112 88 106" fill="none" stroke="#9d4b56" strokeWidth="2.5" strokeLinecap="round" className="hc-mouth"/>
        <path d="M52 94 Q59 90 65 94 M99 94 Q106 90 111 94" fill="none" stroke="#ef9c9d" strokeWidth="4" strokeLinecap="round" opacity=".58" className="hc-blush"/>
        <path d="M60 26 Q80 14 101 27" fill="none" stroke="#f6e8ce" strokeWidth="5" strokeLinecap="round"/>
        <path d="M105 25 Q115 17 120 26 Q114 31 105 25 M106 26 Q107 37 99 39 Q98 31 106 26Z" fill="#d94d72" stroke="#852940" strokeWidth="2"/>
        <path d="M43 53 Q40 76 46 91" fill="none" stroke="#9d7483" strokeWidth="3" opacity=".7"/>
      </g>
      <g className="hc-raised-hand"><path d="M105 147 Q113 143 118 133 L121 119 Q122 114 125 115 Q129 116 128 122 L127 133 Q134 124 137 119 Q140 115 143 118 Q146 121 142 126 L132 141 Q128 149 117 156 L108 157Z" fill="#ffe0c8" stroke="#713f45" strokeWidth="2.4" strokeLinejoin="round"/><path d="M109 151l8 5" stroke="#f3aabc" strokeWidth="4" strokeLinecap="round"/></g>
      <g className="hc-handoff"><path d="M111 94h31v22h-31z" fill="#fff8e9" stroke="#806046" strokeWidth="2"/><path d="M117 101h18M117 107h13" stroke="#2f6b4f" strokeWidth="2" strokeLinecap="round"/><path d="M109 105h-9m0 0 4-4m-4 4 4 4" fill="none" stroke="#bd4670" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></g>
      <g className="hc-clock"><circle cx="132" cy="82" r="13" fill="#fff8e9" stroke="#bd4670" strokeWidth="2.5"/><path d="M132 74v8l5 3" fill="none" stroke="#57464a" strokeWidth="2.5" strokeLinecap="round"/></g>
      <g className="hc-thought"><circle cx="123" cy="45" r="8" fill="#fff8e9" stroke="#806046" strokeWidth="2"/><circle cx="132" cy="34" r="4" fill="#fff8e9" stroke="#806046" strokeWidth="1.5"/><path d="M120 45h6m-3-3v6" stroke="#bd4670" strokeWidth="1.5" strokeLinecap="round"/></g>
      <g className="hc-confetti"><path d="M39 43l-5-5m83 9 7-7m-79 78-7 5m74 8 6 7" stroke="#c9a65a" strokeWidth="3" strokeLinecap="round"/><path d="M36 88l-9 1m98 16 9 2" stroke="#d94d72" strokeWidth="3" strokeLinecap="round"/></g>
      <g className="hc-zzz"><path d="M117 37h14l-14 9h14" fill="none" stroke="#557963" strokeWidth="2.5" strokeLinejoin="round"/><path d="M130 27h9l-9 6h9" fill="none" stroke="#557963" strokeWidth="2" strokeLinejoin="round"/></g>
    </g>
  </svg>;
}
