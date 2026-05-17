(* Wolfram batch probe — read JSON requests on stdin, emit results on stdout.
   This is the EXACT pattern the G2 adapter must use to amortise the 7s cold-start. *)
ImportString[InputString[], "RawJSON"] // ToString // Print;

(* Process 5 inputs in one kernel session *)
Do[
  request = ImportString[InputString[], "RawJSON"];
  fn  = request["fn"];
  nuS = request["nu_str"];
  zS  = request["z_str"];
  prec = request["precision"];
  (* Parse decimal strings to Rationals — CRITICAL: avoid Wolfram input-trap *)
  nu = ToExpression[StringReplace[nuS, "/" -> "/"]];
  z  = ToExpression[StringReplace[zS, "/" -> "/"]];
  fnSym = Switch[fn, "BesselJ", BesselJ, "BesselY", BesselY, "BesselI", BesselI, "BesselK", BesselK];
  result = N[fnSym[nu, z], prec];
  Print["RESULT ", StringSplit[ToString[result, InputForm], "`"][[1]]];
, {5}];
