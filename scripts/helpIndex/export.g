# export_gapdoc.txt: bookDir|url|display|skey|bname|longname
# export_default.txt: bookDir|url|display|skey|bname|entry[4]|entry[5]|entry[3]|longname

f := OutputTextFile("export_gapdoc.txt", false);
d := OutputTextFile("export_default.txt", false);
oldSize := SizeScreen();
SizeScreen([4000, oldSize[2]]);

for i in [1..Length(HELP_KNOWN_BOOKS[1])] do
    bname := HELP_KNOWN_BOOKS[2][i][1];
    longname := HELP_KNOWN_BOOKS[2][i][2];
    bdir  := HELP_KNOWN_BOOKS[2][i][3];
    info  := HELP_BOOK_INFO(HELP_KNOWN_BOOKS[1][i]);

    if IsBound(info.directory) then
        bookDir := info.directory![1];
    else
        bookDir := bdir![1];
    fi;

    while Length(bookDir) > 0 and bookDir[Length(bookDir)] = '/' do
        bookDir := bookDir{[1..Length(bookDir)-1]};
    od;
    
    for e in [1..Length(info.entries)] do
        entry := info.entries[e];
        display := entry[1];
        display := ReplacedString(display, "|", "/");

        if IsBound(entry[6]) then skey := entry[6];
        else skey := entry[2]; fi;

        url := HELP_BOOK_HANDLER.(info.handler).HelpData(info, e, "url");
        if url = fail then continue; fi;
        
        if info.handler = "GapDocGAP" then
            AppendTo(f, bookDir);
            AppendTo(f, "|");
            AppendTo(f, url);
            AppendTo(f, "|");
            AppendTo(f, display);
            AppendTo(f, "|");
            AppendTo(f, skey);
            AppendTo(f, "|");
            AppendTo(f, bname);
            AppendTo(f, "|");
            AppendTo(f, longname);
            AppendTo(f, "\n");
        else
            AppendTo(d, bookDir);
            AppendTo(d, "|");
            AppendTo(d, url);
            AppendTo(d, "|");
            AppendTo(d, display);
            AppendTo(d, "|");
            AppendTo(d, skey);
            AppendTo(d, "|");
            AppendTo(d, bname);
            AppendTo(d, "|");
            AppendTo(d, String(entry[4]));
            AppendTo(d, "|");
            AppendTo(d, String(entry[5]));
            AppendTo(d, "|");
            AppendTo(d, entry[3]);
            AppendTo(d, "|");
            AppendTo(d, longname);
            AppendTo(d, "\n");
        fi;
    
    od;
od;

CloseStream(f);
CloseStream(d);
