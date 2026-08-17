# export_text.txt: bookDir|display|skey|bname|txt|entry[4]|entry[5]|entry[3]|longname

f := OutputTextFile("export_text.txt", false);
oldSize := SizeScreen();
SizeScreen([100000, oldSize[2]]);

for i in [1..Length(HELP_KNOWN_BOOKS[1])] do
    bname := HELP_KNOWN_BOOKS[2][i][1];
    longname := HELP_KNOWN_BOOKS[2][i][2];
    bdir  := HELP_KNOWN_BOOKS[2][i][3];
    info  := HELP_BOOK_INFO(HELP_KNOWN_BOOKS[1][i]);
    if info = fail then continue; fi;

    if IsBound(info.directory) then
        bookDir := info.directory![1];
    else
        bookDir := bdir![1];
    fi;

    for e in [1..Length(info.entries)] do
        entry := info.entries[e];
        url := HELP_BOOK_HANDLER.(info.handler).HelpData(info, e, "url");
        if url <> fail then continue; fi;

        data := HELP_BOOK_HANDLER.(info.handler).HelpData(info, e, "text");
        if data = fail then continue; fi;

        if IsString(data.lines) then
            txt := data.lines;
        elif IsList(data.lines) then
            if IsBound(data.start) then
                txt := JoinStringsWithSeparator(data.lines{[data.start..Length(data.lines)]}, "\n");
            else
                txt := JoinStringsWithSeparator(data.lines, "\n");
            fi;
        else
            continue;
        fi;

        txt := ReplacedString(txt, "|", "/");
        txt := ReplacedString(txt, "\n", "__NL__");
        txt := ReplacedString(txt, "\r", "");

        display := entry[1];
        display := ReplacedString(display, "|", "/");
        display := ReplacedString(ReplacedString(display, "\r", ""), "\n", " ");

        if IsBound(entry[6]) then skey := entry[6];
        else skey := entry[2]; fi;

        AppendTo(f, bookDir, "|", display, "|", skey, "|", bname, "|",
                 txt, "|", String(entry[4]), "|", String(entry[5]), "|",
                 entry[3], "|", longname, "\n");
    od;
od;

SizeScreen(oldSize);
CloseStream(f);
