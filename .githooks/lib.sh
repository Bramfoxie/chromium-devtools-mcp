# General punctuation, arrows, math and technical symbols, dingbats, emoji, nbsp, middle dot, guillemets, multiplication sign, variation selectors, BOM; built from octal escapes to stay ASCII.
typography="$(printf '\342\200[\200-\277]')|$(printf '\342\201[\200-\257]')|$(printf '\342[\206-\217]')|$(printf '\342[\230-\236]')|$(printf '\360\237')|$(printf '\302[\240\253\267\273]')|$(printf '\303\227')|$(printf '\357\270[\200-\217]')|$(printf '\357\273\277')"
attribution='co-authored-by:|generated with|noreply@anthropic'

has_typography() {
  LC_ALL=C grep -qIE "$typography"
}

has_attribution() {
  grep -qiE "$attribution"
}
