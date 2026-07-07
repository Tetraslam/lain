# demo.tape — README demo recording (charmbracelet/vhs).
#
#   vhs demo.tape        → docs/demo.gif
#
# Needs `lain` on PATH and a finished exploration db. By default it uses the
# fifth-fundamental-force demo exploration; point LAIN_DEMO_DB elsewhere to
# re-record with a different one.

Output docs/demo.gif

Set Theme "TokyoNight"
Set FontSize 15
Set Width 1200
Set Height 720
Set Padding 16
Set TypingSpeed 40ms

# ---- hidden setup: stage the demo db in a clean temp dir ----
Hide
Type `demo="${LAIN_DEMO_DB:-$HOME/Programming/lain-test/a-world-with-a-fifth-fundamental-force.db}"; dir="$(mktemp -d)"; cp "$demo" "$dir/a-world-with-a-fifth-fundamental-force.db"; cd "$dir"; clear`
Enter
Sleep 1s
Show

# ---- the graph ----
Type "lain tree"
Enter
Sleep 5s

# ---- a node ----
Type "lain show root-1"
Enter
Sleep 6s

# ---- the TUI ----
Type "lain tui a-world-with-a-fifth-fundamental-force.db"
Enter
Sleep 3.5s

# walk the tree
Down@350ms 3
Sleep 1.5s

# read the node
Enter
Sleep 2.5s
Down@180ms 8
Sleep 2s
Escape
Sleep 1s

# radial graph view
Type "g"
Sleep 3s
Right@450ms 2
Sleep 1.5s
Down@450ms 1
Sleep 2.5s

# out
Escape
Sleep 600ms
Type "q"
Sleep 600ms
Type "q"
Sleep 1.5s
