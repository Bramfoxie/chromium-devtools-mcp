# Dashes, minus, ellipsis, smart quotes, bullets, arrows, nbsp, middle dot, emoji, dingbats; built from octal escapes to stay ASCII.
typography="$(printf '\342\200[\220\221\222\223\224\225\230\231\234\235\242\246]')|$(printf '\342\206[\220\221\222\223]')|$(printf '\342\210\222')|$(printf '\302[\240\267]')|$(printf '\360\237')|$(printf '\342[\230\231\232\233\234\235\236]')"
attribution='co-authored-by:|generated with|noreply@anthropic'

has_typography() {
  LC_ALL=C grep -qIE "$typography"
}

has_attribution() {
  grep -qiE "$attribution"
}
