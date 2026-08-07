
LoadAllPackages();;

names := NamesGVars();;

names := Filtered(names, n -> IsBoundGlobal(n));;

funcs := Filtered(names, n -> IsFunction(ValueGlobal(n)));;
Sort(funcs);;

content := JoinStringsWithSeparator(funcs, "\n");;
content := Concatenation(content, "\nData generation done, ready to convert");;
stream := OutputTextFile("data/completionData/functions-all.txt", false);;
WriteAll(stream, content);;
CloseStream(stream);;
